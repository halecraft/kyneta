/**
 * Reactive primitives for local state.
 *
 * This module provides `LocalRef` and `state()` — the local reactive
 * primitive for Kyneta components. These use the `CHANGEFEED` protocol
 * from `@kyneta/schema`.
 *
 * @packageDocumentation
 */

export type { LocalRef } from "./local-ref.js"
export { isLocalRef, state } from "./local-ref.js"
