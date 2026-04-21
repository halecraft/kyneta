// testing — barrel file for @kyneta/exchange test utilities.
//
// Exported via the "./testing" path in package.json.
// These utilities carry a vitest dependency and must NOT be
// re-exported from the main "." barrel.

export {
  collectAll,
  describeStore,
  makeBinaryEntryRecord,
  makeEntryRecord,
  makeMetaRecord,
  plainMeta,
} from "./store-conformance.js"