// @kyneta/changefeed — the universal reactive contract.
//
// This barrel re-exports everything from the three source modules
// that make up the changefeed contract package.

// Callable — the createCallable combinator
export type { CallableChangefeed } from "./callable.js"
export { createCallable } from "./callable.js"
// ChangeBase — the universal base type for all changes
export type { ChangeBase } from "./change.js"
// Changefeed — symbol, types, type guards, factories, projector
export type {
  Changefeed,
  ChangefeedProtocol,
  Changeset,
  HasChangefeed,
} from "./changefeed.js"
export {
  CHANGEFEED,
  changefeed,
  createChangefeed,
  hasChangefeed,
  staticChangefeed,
} from "./changefeed.js"
// ReactiveMap — callable changefeed over a mutable Map
export type { ReactiveMap, ReactiveMapHandle } from "./reactive-map.js"
export { createReactiveMap } from "./reactive-map.js"
