// create-doc — generic document construction for any substrate.
//
// createRef(schema, substrate) builds a full-stack ref from a schema and
// a pre-built substrate. Used by createDoc (public) and the exchange (internal).
//
// createDoc(bound) creates a live document from a BoundSchema — the single
// public entry point that replaces per-substrate createLoroDoc, createYjsDoc,
// and createDoc (basic).
//
// [NATIVE] is attached during interpretation via the nativeResolver protocol.
// [SUBSTRATE] is attached by createRef on the root ref for sync functions.

import type { Lease } from "@kyneta/machine"
import { randomPeerId } from "@kyneta/random"
import type { BoundSchema } from "./bind.js"
import { interpret } from "./interpret.js"
import { observation, readable, writable } from "./layers.js"
import type { NativeMap } from "./native.js"
import { SUBSTRATE } from "./native.js"
import type { DocRef } from "./ref.js"
import type { Schema as SchemaType } from "./schema.js"
import type { Substrate, SubstratePayload, Version } from "./substrate.js"

// ---------------------------------------------------------------------------
// createRef — internal core: schema + substrate → ref
// ---------------------------------------------------------------------------

/**
 * Build a full-stack ref from a schema and a pre-built substrate.
 *
 * This is the internal core used by `createDoc` (public) and the exchange.
 * It runs the full interpret pipeline (readable + writable + observation)
 * and attaches `[SUBSTRATE]` on the root ref for sync functions.
 *
 * `[NATIVE]` is attached automatically during interpretation by
 * `interpretImpl` via the `nativeResolver` protocol — no action needed here.
 *
 * When `options.lease` is provided, it's attached to the substrate's ctx
 * before interpretation runs. The observation layer's per-context
 * dispatcher (`with-changefeed.ts:ensurePrepareWiring`) reads it from
 * the ctx and uses it instead of creating a private lease. This lets
 * doc-layer dispatchers cooperate with the Exchange's Synchronizer
 * under one shared cascade budget.
 *
 * **Lease attachment timing on cached ctx is exotic-but-defined.**
 * `substrate.context()` is cached per-substrate. The dispatcher is
 * constructed on the first `ensurePrepareWiring(ctx)` call (during the
 * observation layer's `.with()` step), and captures whatever value
 * `ctx.lease` holds at that moment. Subsequent `createRef` calls on the
 * same substrate would overwrite `ctx.lease` but cannot re-create the
 * dispatcher — the captured lease binding is fixed. The Exchange's
 * normal flow (one substrate per doc, one `createRef` per substrate)
 * never reaches this corner.
 *
 * @param schema - The root schema
 * @param substrate - A pre-built substrate (from factory.create or factory.fromEntirety)
 * @param options - Optional `{ lease }` for cooperating cascade budgets
 * @returns A full-stack ref (opaque — cast at call site)
 */
export function createRef(
  schema: SchemaType,
  substrate: Substrate<Version>,
  options?: { lease?: Lease },
): any {
  const ctx = substrate.context()
  if (options?.lease) {
    ctx.lease = options.lease
  }
  // The `as any` on the builder avoids TS2589 — interpret's fluent API
  // produces deeply recursive types when S is the abstract SchemaType.
  // The public createDoc signature provides the correct DocRef<S, N>
  // return type via the CreateDoc interface call signature pattern.
  const ref: any = (interpret as any)(schema, ctx)
    .with(readable)
    .with(writable)
    .with(observation)
    .done()
  Object.defineProperty(ref, SUBSTRATE, {
    value: substrate,
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return ref
}

// ---------------------------------------------------------------------------
// createDoc — public API: BoundSchema → DocRef
// ---------------------------------------------------------------------------

/**
 * Create a live document from a BoundSchema.
 *
 * The single public entry point for document construction. The substrate
 * is determined by the BoundSchema (which carries the factory builder).
 *
 * For standalone use — generates a random peerId. The exchange provides
 * its own stable peerId and calls `createRef` directly.
 *
 * Supports an optional `payload` for hydrating from an exported entirety.
 *
 * ```ts
 * // Fresh document
 * const doc = createDoc(loro.bind(schema))
 *
 * // Hydrate from export
 * const doc = createDoc(loro.bind(schema), payload)
 * ```
 *
 * @param bound - A BoundSchema from json.bind(), loro.bind(), or yjs.bind()
 * @param payload - Optional SubstratePayload for hydration (from exportEntirety)
 * @returns A full-stack DocRef<S, N> with typed [NATIVE] at every node
 */
type CreateDoc = {
  <S extends SchemaType, N extends NativeMap>(
    bound: BoundSchema<S, N>,
    payload?: SubstratePayload,
    peerId?: string,
  ): DocRef<S, N>
  <S extends SchemaType, N extends NativeMap>(
    bound: BoundSchema<S, N>,
    payload: SubstratePayload,
    peerId?: string,
  ): DocRef<S, N>
}

export const createDoc: CreateDoc = ((
  bound: BoundSchema<any, any>,
  payload?: SubstratePayload,
  peerId?: string,
): any => {
  const factory = bound.factory({
    peerId: peerId ?? randomPeerId(),
    binding: bound.identityBinding,
  })
  const substrate = payload
    ? factory.fromEntirety(payload, bound.schema)
    : factory.create(bound.schema)
  return createRef(bound.schema, substrate)
}) as CreateDoc
