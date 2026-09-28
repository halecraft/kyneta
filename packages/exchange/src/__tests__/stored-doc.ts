// stored-doc — a store that already holds a plain document, for tests that
// load one.

import {
  createInMemoryStoreData,
  InMemoryStore,
  type InMemoryStoreData,
} from "../store/in-memory-store.js"
import {
  makeMetaRecord,
  makePlainEntirety,
  UNAUTHORED,
} from "../testing/store-conformance.js"

/** A store holding plain document `doc-1` as `state`, written whole. */
export async function seedStoredDoc(
  state: Record<string, unknown>,
): Promise<InMemoryStoreData> {
  const sharedData: InMemoryStoreData = createInMemoryStoreData()
  const backend = new InMemoryStore(sharedData)
  await backend.append("doc-1", makeMetaRecord(), UNAUTHORED)
  await backend.append("doc-1", makePlainEntirety(state), UNAUTHORED)
  return sharedData
}
