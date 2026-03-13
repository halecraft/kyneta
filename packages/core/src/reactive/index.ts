/**
 * Reactive primitives for local state.
 *
 * This module provides `LocalRef` and `state()` — the local reactive
 * primitive for Kinetic components. These use the `CHANGEFEED` protocol
 * from `@kyneta/schema`, replacing the old `REACTIVE`+`SNAPSHOT` design
 * from `@loro-extended/reactive`.
 *
 * @packageDocumentation
 */

export type { LocalRef } from "./local-ref.js"
export { state, isLocalRef } from "./local-ref.js"