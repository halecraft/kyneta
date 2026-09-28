// testing — barrel file for @kyneta/exchange test utilities.
//
// Exported via the "./testing" path in package.json.
// These utilities carry a vitest dependency and must NOT be
// re-exported from the main "." barrel.

export { abandonSeat } from "../store/in-memory-store.js"
export { type ArmedFault, makeArmedFault } from "./fault-injection.js"
export {
  AUTHORED,
  collectAll,
  type DescribeStoreOptions,
  describeStore,
  type FaultInjection,
  type IsolationPair,
  makeBinaryEntryRecord,
  makeEntryRecord,
  makeMetaRecord,
  makePlainEntirety,
  plainMeta,
  type SeatDeclaration,
  type SeatStorage,
  UNAUTHORED,
} from "./store-conformance.js"
