// step — pure state transitions: (State, Action) → State
//
// Each step function applies an action to a plain value, producing the
// next plain value. No CRDT runtime required — this is pure computation.
//
// step dispatches on the action's `type` discriminant (not on the schema).
// The schema says "sequence"; the backend picks the action vocabulary.
// step is action-driven and schema-agnostic.

import type {
  ChangeBase,
  TextChange,
  TextInstruction,
  SequenceChange,
  SequenceInstruction,
  MapChange,
  ReplaceChange,
  IncrementChange,
} from "./change.js"

// ---------------------------------------------------------------------------
// stepText — apply retain/insert/delete ops to a string
// ---------------------------------------------------------------------------

/**
 * Applies a `TextAction` to a string, producing a new string.
 *
 * ```
 * stepText("Hello", { type: "text", ops: [{ retain: 5 }, { insert: " World" }] })
 * → "Hello World"
 * ```
 *
 * Ops are cursor-based: the cursor starts at 0 and advances through
 * retains and deletes. Inserts add characters at the cursor position.
 */
export function stepText(state: string, action: TextChange): string {
  let cursor = 0
  let result = ""

  for (const op of action.instructions) {
    if ("retain" in op) {
      result += state.slice(cursor, cursor + op.retain)
      cursor += op.retain
    } else if ("insert" in op) {
      result += op.insert
    } else if ("delete" in op) {
      cursor += op.delete
    }
  }

  // Append any remaining characters after the last op
  if (cursor < state.length) {
    result += state.slice(cursor)
  }

  return result
}

// ---------------------------------------------------------------------------
// stepSequence — apply retain/insert/delete ops to an array
// ---------------------------------------------------------------------------

/**
 * Applies a `SequenceAction` to an array, producing a new array.
 *
 * ```
 * stepSequence([1, 2, 3], { type: "sequence", ops: [
 *   { retain: 1 }, { insert: [10, 20] }, { delete: 1 }
 * ] })
 * → [1, 10, 20, 3]
 * ```
 *
 * Same cursor semantics as text, but over array items.
 */
export function stepSequence<T>(
  state: readonly T[],
  action: SequenceChange<T>,
): T[] {
  let cursor = 0
  const result: T[] = []

  for (const op of action.instructions) {
    if ("retain" in op) {
      for (let i = 0; i < (op as { retain: number }).retain; i++) {
        if (cursor < state.length) {
          result.push(state[cursor]!)
          cursor++
        }
      }
    } else if ("insert" in op) {
      for (const item of (op as { insert: readonly T[] }).insert) {
        result.push(item)
      }
    } else if ("delete" in op) {
      cursor += (op as { delete: number }).delete
    }
  }

  // Append any remaining items after the last op
  while (cursor < state.length) {
    result.push(state[cursor]!)
    cursor++
  }

  return result
}

// ---------------------------------------------------------------------------
// stepMap — apply set/delete to a plain object
// ---------------------------------------------------------------------------

/**
 * Applies a `MapAction` to a plain object, producing a new object.
 *
 * ```
 * stepMap({ a: 1, b: 2 }, { type: "map", set: { a: 10 }, delete: ["b"] })
 * → { a: 10 }
 * ```
 *
 * Order: deletes are applied first, then sets. This means a key that
 * appears in both `delete` and `set` will end up with the `set` value.
 */
export function stepMap<T extends Record<string, unknown>>(
  state: T,
  action: MapChange,
): T {
  const result = { ...state }

  if (action.delete) {
    for (const key of action.delete) {
      delete (result as Record<string, unknown>)[key]
    }
  }

  if (action.set) {
    for (const [key, value] of Object.entries(action.set)) {
      (result as Record<string, unknown>)[key] = value
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// stepReplace — wholesale scalar replacement
// ---------------------------------------------------------------------------

/**
 * Applies a `ReplaceAction` — simply returns the new value.
 *
 * ```
 * stepReplace(42, { type: "replace", value: 99 })
 * → 99
 * ```
 */
export function stepReplace<T>(_state: T, action: ReplaceChange<T>): T {
  return action.value
}

// ---------------------------------------------------------------------------
// stepIncrement — counter increment/decrement
// ---------------------------------------------------------------------------

/**
 * Applies an `IncrementAction` to a number.
 *
 * ```
 * stepIncrement(10, { type: "increment", amount: 5 })
 * → 15
 * ```
 */
export function stepIncrement(state: number, action: IncrementChange): number {
  return state + action.amount
}

// ---------------------------------------------------------------------------
// step — top-level dispatcher
// ---------------------------------------------------------------------------

/**
 * Applies an action to a state value, dispatching on the action's `type`.
 *
 * This is the generic entry point. For known action types it delegates to
 * the specific step function. For unknown action types it throws — callers
 * handling third-party actions should use the specific step functions or
 * register their own dispatchers.
 *
 * ```
 * step("Hello", { type: "text", ops: [{ retain: 5 }, { insert: " World" }] })
 * → "Hello World"
 *
 * step([1, 2, 3], { type: "sequence", ops: [{ retain: 1 }, { delete: 1 }] })
 * → [1, 3]
 *
 * step({ a: 1 }, { type: "map", set: { b: 2 } })
 * → { a: 1, b: 2 }
 *
 * step(42, { type: "replace", value: 99 })
 * → 99
 *
 * step(10, { type: "increment", amount: 5 })
 * → 15
 * ```
 */
export function step<S>(state: S, action: ChangeBase): S {
  switch (action.type) {
    case "text":
      return stepText(state as string, action as TextChange) as S

    case "sequence":
      return stepSequence(state as unknown[], action as SequenceChange) as S

    case "map":
      return stepMap(
        state as Record<string, unknown>,
        action as MapChange,
      ) as S

    case "replace":
      return stepReplace(state, action as ReplaceChange<S>)

    case "increment":
      return stepIncrement(state as number, action as IncrementChange) as S

    default:
      throw new Error(
        `step: unknown action type "${action.type}". ` +
          `Use a specific step function for third-party action types.`,
      )
  }
}