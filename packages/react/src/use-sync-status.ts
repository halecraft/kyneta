// use-sync-status — reactive sync ready-state subscription.
//
// useSyncStatus(doc) returns the current ReadyState[] for a document
// obtained from exchange.get(), and re-renders when the sync status
// changes (e.g. when a peer connects, syncs, or disconnects).
//
// All logic lives in createSyncStore (Functional Core); this hook
// is a thin Imperative Shell wrapper.

import { type ReadyState, sync } from "@kyneta/exchange"
import { useMemo, useSyncExternalStore } from "react"
import { createSyncStore } from "./store.js"

// ---------------------------------------------------------------------------
// useSyncStatus
// ---------------------------------------------------------------------------

/**
 * Subscribe to a document's sync ready-state.
 *
 * Returns the current `ReadyState[]` and re-renders when the sync
 * status changes. The document must have been created via
 * `exchange.get()` (i.e. it must have sync capabilities).
 *
 * ```tsx
 * function SyncIndicator({ doc }: { doc: Ref<typeof MySchema> }) {
 *   const readyStates = useSyncStatus(doc)
 *   const synced = readyStates.some(s => s.state === "ready")
 *   return <span>{synced ? "✅ Synced" : "⏳ Syncing..."}</span>
 * }
 * ```
 *
 * @param doc - A document ref from `exchange.get()` (or `useDocument()`).
 * @returns The current ReadyState[] array.
 * @throws If `doc` was not created via `exchange.get()` (no sync capabilities).
 */
export function useSyncStatus(doc: object): ReadyState[] {
  const store = useMemo(() => createSyncStore(sync(doc)), [doc])
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}
