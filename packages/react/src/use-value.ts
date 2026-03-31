// use-value — reactive subscription to a ref's current plain value.
//
// useValue(ref) returns Plain<S> and re-renders when the ref changes.
// The snapshot is memoized for referential equality — downstream
// useMemo/React.memo see stable identity unless a real change occurred.
//
// Uses a single conditional return type to handle null/undefined
// passthrough without overload explosion:
//   CallableRef → ReturnType<R>
//   null → null
//   undefined → undefined

import { useMemo, useSyncExternalStore } from "react"
import {
  type CallableRef,
  createChangefeedStore,
  createNullishStore,
} from "./store.js"

// ---------------------------------------------------------------------------
// useValue
// ---------------------------------------------------------------------------

/**
 * Subscribe to a ref's current plain value.
 *
 * Returns `Plain<S>` — a plain JS snapshot — and re-renders when the
 * ref's changefeed fires. The snapshot is memoized: `getSnapshot()`
 * returns the same object reference until a real change occurs.
 *
 * For composite refs (products, sequences, maps), subscribes deep
 * (via `subscribeTree`) — re-renders on any descendant change.
 * For leaf refs (scalars, text, counters), subscribes at node level.
 *
 * Accepts `null` or `undefined` and returns them unchanged, with
 * stable hook call count (no conditional hook calls).
 *
 * ```tsx
 * function TodoList({ doc }: { doc: Ref<typeof TodoSchema> }) {
 *   const value = useValue(doc)
 *   // value: { title: string, items: { text: string, done: boolean }[] }
 *   return <h1>{value.title}</h1>
 * }
 *
 * // Leaf subscription — only re-renders when title changes:
 * function Title({ doc }: { doc: Ref<typeof TodoSchema> }) {
 *   const title = useValue(doc.title)
 *   return <h1>{title}</h1>
 * }
 *
 * // Nullish passthrough:
 * const value = useValue(maybeRef) // null | undefined passes through
 * ```
 *
 * @param ref - A callable ref with [CHANGEFEED], or null/undefined.
 * @returns The plain snapshot value, or null/undefined if input is nullish.
 */
export function useValue<R extends CallableRef | null | undefined>(
  ref: R,
): R extends CallableRef ? ReturnType<R> : R {
  const store = useMemo(
    () =>
      ref == null
        ? createNullishStore(ref as null | undefined)
        : createChangefeedStore(ref as CallableRef),
    [ref],
  )

  return useSyncExternalStore(store.subscribe, store.getSnapshot) as any
}
