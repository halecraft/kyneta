// use-document — reactive document access from an Exchange.
//
// useDocument(docId, bound) retrieves a cached Ref<S> from the
// Exchange provided by ExchangeProvider. Since exchange.get() is
// idempotent (same docId + same BoundSchema returns the same ref),
// no additional caching is needed beyond useMemo.
//
// Uses the interface call signature pattern to avoid TS2589 —
// the deeply recursive Ref<S> type exceeds TypeScript's depth
// budget when S is a generic parameter inside useMemo's callback.

import { useMemo } from "react"
import type { BoundSchema, Ref, SchemaNode } from "@kyneta/schema"
import type { Exchange } from "@kyneta/exchange"
import { useExchange } from "./exchange-context.js"

// ---------------------------------------------------------------------------
// UseDocument — interface call signature avoids TS2589
// ---------------------------------------------------------------------------

// The `as any` cast inside the implementation avoids TS2589: useMemo
// tries to evaluate Exchange.get()'s return type Ref<S> deeply when
// S is a generic parameter, exceeding TypeScript's recursion budget.
// The outer call signature provides the correct Ref<S> return type.

type UseDocument = <S extends SchemaNode>(
  docId: string,
  bound: BoundSchema<S>,
) => Ref<S>

// ---------------------------------------------------------------------------
// useDocument
// ---------------------------------------------------------------------------

/**
 * Get (or create) a document from the Exchange.
 *
 * Returns a full-stack `Ref<S>` — callable, navigable, writable,
 * transactable, and observable. The ref is backed by a substrate
 * determined by the BoundSchema's factory builder.
 *
 * Multiple calls with the same `docId` and `bound` return the same
 * ref instance (Exchange.get() is idempotent).
 *
 * ```tsx
 * import { bindLoro, LoroSchema } from "@kyneta/loro-schema"
 * const TodoDoc = bindLoro(LoroSchema.doc({ title: LoroSchema.text() }))
 *
 * function App() {
 *   const doc = useDocument("my-doc", TodoDoc)
 *   const value = useValue(doc)
 *   return <h1>{value.title}</h1>
 * }
 * ```
 *
 * @param docId - The document identifier.
 * @param bound - A BoundSchema created by `bindLoro()`, `bindPlain()`, etc.
 * @returns A full-stack Ref<S> with sync capabilities via `sync()`.
 */
export const useDocument: UseDocument = (docId, bound) => {
  const exchange: Exchange = useExchange()
  return useMemo(
    () => (exchange as any).get(docId, bound),
    [exchange, docId, bound],
  )
}