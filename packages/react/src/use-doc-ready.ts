// use-doc-ready — "is it safe to read this document yet?"
//
// Sugar over useDocStatus: ready means "not still waiting to find out". Kept
// as its own hook because the boolean reads better at a call site that only
// wants a gate, and because it is the older, established name.

import type { PeerIdentityDetails } from "@kyneta/exchange"
import { useDocStatus } from "./use-doc-status.js"

/**
 * Subscribe to a document's readiness gate.
 *
 * Returns `false` while some truth source has yet to report, and `true` once
 * everything has — whether the document turned out to have data or not.
 * Monotonic in practice, and flicker-free: the snapshot is a boolean, so
 * `useSyncExternalStore` bails out when it has not moved.
 *
 * ```tsx
 * function Menu({ userDoc }: { userDoc: Ref<typeof UserSchema> }) {
 *   const ready = useDocReady(userDoc)
 *   if (!ready) return <Spinner />
 *   return <MenuItems doc={userDoc} />
 * }
 * ```
 *
 * If you need to distinguish "ready and empty" from "ready with data" — which
 * is the distinction that decides whether writing defaults is safe — use
 * {@link useDocStatus} directly, or {@link useInitialize} to act on it.
 *
 * @param doc - A document ref (or any ref within one).
 * @param opts.peer - Require this specific peer to have answered, rather than
 *   accepting whichever source reports first.
 */
export function useDocReady(
  doc: object,
  opts?: { peer?: (peer: PeerIdentityDetails) => boolean },
): boolean {
  const pred = opts?.peer
  return useDocStatus(doc, pred ? { authority: pred } : undefined) !== "pending"
}
