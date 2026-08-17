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
import { observation, readable, tracking, writable } from "./layers.js"
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
    .with(tracking)
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
// createDoc / createDocAs — public API: BoundSchema → DocRef
// ---------------------------------------------------------------------------

/**
 * The shared implementation behind both public surfaces. Not exported, and
 * named to be unattractive: it throws away the schema's types, handing back
 * `any`. Reach for `createDoc` or `createDocAs` instead.
 *
 * The types are dropped deliberately rather than accidentally. Resolving
 * `DocRef<S, N>` against an abstract `S` makes TypeScript walk the whole
 * recursive ref tree and trip its instantiation-depth limit (TS2589). So the
 * work happens once, untyped, and each public surface re-attaches the precise
 * type through a declared call signature — the same split `Exchange.get` keeps
 * between its signature and its body.
 */
function createDocUnderPeerIdUntyped(
  peerId: string,
  bound: BoundSchema<any, any>,
  payload?: SubstratePayload,
): any {
  const factory = bound.factory({
    peerId,
    binding: bound.identityBinding,
  })
  const substrate = payload
    ? factory.fromEntirety(payload, bound.schema)
    : factory.create(bound.schema)
  return createRef(bound.schema, substrate)
}

/**
 * Create a live document under a specific peer identity.
 *
 * A CRDT attributes every operation to whoever made it, so a document's
 * identity is part of what its operations *mean*. Most standalone documents
 * never need to care — nobody else will read their operations — which is what
 * {@link createDoc} is for. Reach for this one when the identity is load-
 * bearing:
 *
 * - the document's operations will be exported and attributed to a named peer;
 * - two documents must be distinguishable *reproducibly*, so that a difference
 *   between runs means something rather than being the identity churn.
 *
 * `peerId` is required and leads, rather than trailing as an optional. A
 * caller either does not care about identity — and uses {@link createDoc},
 * which never mentions it — or does care, and has to say so. There is no
 * middle state where a caller ends up with an identity it never chose.
 *
 * ```ts
 * const a = createDocAs("peer-a", yjs.bind(schema))
 * const b = createDocAs("peer-b", yjs.bind(schema))
 * ```
 *
 * @param peerId - The peer identity to attribute this document's operations to
 * @param bound - A BoundSchema from json.bind(), loro.bind(), or yjs.bind()
 * @param payload - Optional SubstratePayload for hydration (from exportEntirety)
 * @returns A full-stack DocRef<S, N> with typed [NATIVE] at every node
 */
type CreateDocAs = <S extends SchemaType, N extends NativeMap>(
  peerId: string,
  bound: BoundSchema<S, N>,
  payload?: SubstratePayload,
) => DocRef<S, N>

export const createDocAs: CreateDocAs =
  createDocUnderPeerIdUntyped as CreateDocAs

/**
 * Create a live document from a BoundSchema.
 *
 * The single public entry point for document construction. The substrate
 * is determined by the BoundSchema (which carries the factory builder).
 *
 * For standalone use. **The peer identity is arbitrary** — a fresh random one
 * each time — which is the right default when nothing will read this
 * document's operations but this process. When the identity matters, use
 * {@link createDocAs} and name it. (The exchange takes neither path: it holds
 * its own stable peerId and calls `createRef` directly.)
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
type CreateDoc = <S extends SchemaType, N extends NativeMap>(
  bound: BoundSchema<S, N>,
  payload?: SubstratePayload,
) => DocRef<S, N>

export const createDoc: CreateDoc = ((
  bound: BoundSchema<any, any>,
  payload?: SubstratePayload,
): any =>
  createDocUnderPeerIdUntyped(randomPeerId(), bound, payload)) as CreateDoc
