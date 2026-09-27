// stored-doc — a store that already holds a plain document, for tests that
// load one.

import {
  InMemoryStore,
  type InMemoryStoreData,
} from "../store/in-memory-store.js"
import {
  makeMetaRecord,
  makePlainEntirety,
} from "../testing/store-conformance.js"

/** A store holding plain document `doc-1` as `state`, written whole. */
export async function seedStoredDoc(
  state: Record<string, unknown>,
): Promise<InMemoryStoreData> {
  const sharedData: InMemoryStoreData = {
    records: new Map(),
    metadata: new Map(),
  }
  const backend = new InMemoryStore(sharedData)
  await backend.append("doc-1", makeMetaRecord())
  await backend.append("doc-1", makePlainEntirety(state))
  return sharedData
}
