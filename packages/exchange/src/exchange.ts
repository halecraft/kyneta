// exchange — the public API for @kyneta/exchange.
//
// The Exchange class is the central orchestrator for substrate-agnostic
// state synchronization. It manages document lifecycle, coordinates
// adapters, and provides the main API for document operations.
//
// Usage:
//   const exchange = new Exchange({
//     identity: { name: "alice" },
//     adapters: [network],
//   })
//
//   const TodoDoc = bindLoro(LoroSchema.doc({ title: LoroSchema.text() }))
//   const doc = exchange.get("my-doc", TodoDoc)
//   sync(doc).waitForSync()

import {
  interpret,
  type Ref,
  type Schema as SchemaNode,
  type BoundSchema,
  type FactoryBuilder,
  type SubstrateFactory,
  isBoundSchema,
  registerSubstrate,
} from "@kyneta/schema"
import { changefeed, readable, subscribe, writable } from "@kyneta/schema"
import type { AnyAdapter } from "./adapter/adapter.js"
import type { Permissions } from "./permissions.js"
import { registerSync } from "./sync.js"
import { Synchronizer } from "./synchronizer.js"
import type { DocId, PeerIdentityDetails } from "./types.js"
import { generatePeerId, validatePeerId } from "./utils.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Callback invoked when a peer announces a document the local exchange
 * doesn't have. Return a `BoundSchema` to auto-create the document,
 * or `undefined` to ignore it.
 *
 * @param docId - The document ID announced by the peer
 * @param peer - Identity of the peer that announced the document
 * @returns A BoundSchema to create the document, or undefined to ignore
 */
export type OnDocDiscovered = (
  docId: DocId,
  peer: PeerIdentityDetails,
) => BoundSchema | undefined

/**
 * Options for creating an Exchange.
 */
export type ExchangeParams = {
  /**
   * Peer identity. If `peerId` is omitted, one is auto-generated.
   */
  identity?: Partial<PeerIdentityDetails>

  /**
   * Adapters for network and storage connectivity.
   */
  adapters?: AnyAdapter[]

  /**
   * Permission predicates controlling document access.
   */
  permissions?: Partial<Permissions>

  /**
   * Called when a peer discovers a document this exchange doesn't have.
   *
   * Return a `BoundSchema` to auto-create the document and begin sync,
   * or `undefined` to ignore the unknown document.
   *
   * This enables dynamic document patterns where one peer creates a
   * document and the other materializes it on demand.
   *
   * @example
   * ```typescript
   * const exchange = new Exchange({
   *   onDocDiscovered: (docId, peer) => {
   *     if (docId.startsWith("input:")) return PlayerInputDoc
   *     return undefined
   *   },
   * })
   * ```
   */
  onDocDiscovered?: OnDocDiscovered
}



// ---------------------------------------------------------------------------
// Doc cache entry
// ---------------------------------------------------------------------------

type DocCacheEntry = {
  ref: any
  bound: BoundSchema
}

// ---------------------------------------------------------------------------
// Exchange
// ---------------------------------------------------------------------------

/**
 * The Exchange class is the central orchestrator for substrate-agnostic
 * state synchronization.
 *
 * It manages the lifecycle of documents, coordinates subsystems (adapters,
 * synchronizer, substrates), and provides the main public API for
 * document operations.
 *
 * A single Exchange can host documents backed by different substrate types
 * simultaneously (heterogeneous documents). Each document's substrate type
 * and sync strategy are determined by its `BoundSchema`.
 *
 * @example
 * ```typescript
 * import { Exchange, sync } from "@kyneta/exchange"
 * import { bindPlain } from "@kyneta/schema"
 * import { bindLoro } from "@kyneta/loro-schema"
 *
 * const exchange = new Exchange({
 *   identity: { name: "alice" },
 *   adapters: [new BridgeAdapter({ adapterType: "peer-a", bridge })],
 * })
 *
 * const TodoDoc = bindLoro(LoroSchema.doc({ title: LoroSchema.text() }))
 * const ConfigDoc = bindPlain(Schema.doc({ theme: Schema.string() }))
 *
 * const doc = exchange.get("my-doc", TodoDoc)
 * const config = exchange.get("config", ConfigDoc)
 * doc.title()  // read
 * change(doc, d => d.title.insert(0, "Hello"))  // write
 * await sync(doc).waitForSync()  // sync
 * ```
 */
export class Exchange {
  readonly peerId: string

  readonly #synchronizer: Synchronizer
  readonly #docCache = new Map<DocId, DocCacheEntry>()

  /**
   * Per-exchange factory cache. Each FactoryBuilder is called at most once
   * per exchange, and the resulting SubstrateFactory is cached here.
   *
   * This ensures:
   * 1. A BoundSchema shared across multiple exchanges gets a fresh factory
   *    per exchange (with the correct peerId).
   * 2. Multiple documents using the same BoundSchema within one exchange
   *    share the same factory instance.
   */
  readonly #factoryCache = new WeakMap<FactoryBuilder<any>, SubstrateFactory<any>>()

  constructor({
    identity = {},
    adapters = [],
    permissions,
    onDocDiscovered,
  }: ExchangeParams = {}) {
    // Resolve peer identity
    const peerId = identity.peerId ?? generatePeerId()
    validatePeerId(peerId)
    this.peerId = peerId

    const fullIdentity: PeerIdentityDetails = {
      peerId,
      name: identity.name,
      type: identity.type ?? "user",
    }

    // Create synchronizer
    this.#synchronizer = new Synchronizer({
      identity: fullIdentity,
      adapters,
      permissions,
      onDocCreationRequested: onDocDiscovered
        ? (docId, peer) => {
            const bound = onDocDiscovered(docId, peer)
            if (bound) {
              // Cast to avoid TS2589 — get()'s Ref<S> return type triggers
              // excessively deep instantiation when S defaults to SchemaNode.
              // We don't need the return value here.
              ;(this as any).get(docId, bound)
            }
          }
        : undefined,
    })
  }

  // =========================================================================
  // PRIVATE — Factory resolution
  // =========================================================================

  /**
   * Resolve a FactoryBuilder to a SubstrateFactory, caching per-exchange.
   *
   * The builder is called with `{ peerId: this.peerId }` on first use.
   * Subsequent calls with the same builder return the cached factory.
   */
  #resolveFactory(builder: FactoryBuilder<any>): SubstrateFactory<any> {
    let factory = this.#factoryCache.get(builder)
    if (!factory) {
      factory = builder({ peerId: this.peerId })
      this.#factoryCache.set(builder, factory)
    }
    return factory
  }

  // =========================================================================
  // PUBLIC API — Document access
  // =========================================================================

  /**
   * Gets (or creates) a document with a bound schema.
   *
   * This is the primary API for accessing documents. Returns a full-stack
   * `Ref<S>` — callable, navigable, writable, transactable, and observable.
   *
   * The ref is backed by a substrate determined by the `BoundSchema`'s
   * factory builder. The bound schema's merge strategy determines how
   * the exchange syncs this document with peers.
   *
   * Multiple calls with the same `docId` return the same instance.
   * Calling with a different BoundSchema for the same `docId` throws.
   *
   * @param docId - The document ID
   * @param bound - A BoundSchema created by `bind()`, `bindPlain()`, `bindLww()`, or `bindLoro()`
   * @returns A full-stack Ref<S> with sync capabilities via `sync()`
   *
   * @example
   * ```typescript
   * import { bindPlain } from "@kyneta/schema"
   * import { bindLoro } from "@kyneta/loro-schema"
   *
   * const TodoDoc = bindLoro(LoroSchema.doc({ title: LoroSchema.text() }))
   * const doc = exchange.get("my-doc", TodoDoc)
   *
   * // Initial content via change() after construction:
   * change(doc, d => { d.title.insert(0, "Hello") })
   * ```
   */
  get<S extends SchemaNode>(
    docId: DocId,
    bound: BoundSchema<S>,
  ): Ref<S> {
    // Check cache first
    const cached = this.#docCache.get(docId)

    if (cached) {
      // Validate BoundSchema matches — throw if different binding for same docId
      if (cached.bound !== bound) {
        throw new Error(
          `Document '${docId}' already exists with a different BoundSchema. ` +
            `Use the same BoundSchema object when calling exchange.get() for the same document.`,
        )
      }

      return cached.ref as Ref<S>
    }

    // Resolve factory from the BoundSchema's builder
    const factory = this.#resolveFactory(bound.factory)

    // Create substrate — empty, with Zero.structural defaults.
    // Initial content should be applied via change() after get().
    const substrate = factory.create(bound.schema)

    // Build the full interpreter stack
    // The `as any` avoids TS2589 — interpret's fluent API produces deeply
    // recursive types when S is the abstract SchemaNode. The public
    // get<S>() signature provides the correct Ref<S> return type.
    const ref: any = (interpret as any)(bound.schema, substrate.context())
      .with(readable)
      .with(writable)
      .with(changefeed)
      .done()

    // Register substrate for unwrap() escape hatch
    registerSubstrate(ref, substrate)

    // Register sync capabilities
    registerSync(ref, {
      peerId: this.peerId,
      docId,
      synchronizer: this.#synchronizer,
    })

    // Cache
    this.#docCache.set(docId, {
      ref,
      bound,
    })

    // Register with synchronizer
    this.#synchronizer.registerDoc({
      docId,
      substrate,
      factory,
      strategy: bound.strategy,
      ref,
      schema: bound.schema,
    })

    // Auto-wire changefeed → synchronizer: when a local mutation fires
    // the changefeed, notify the synchronizer so it pushes to peers.
    // Remote imports arrive with origin "sync" — skip those to avoid echo.
    subscribe(ref, (changeset) => {
      if (changeset.origin === "sync") return
      this.#synchronizer.notifyLocalChange(docId)
    })

    return ref as Ref<S>
  }

  /**
   * Check if a document exists in the exchange.
   *
   * @param docId - The document ID
   * @returns true if the document exists
   */
  has(docId: DocId): boolean {
    return this.#docCache.has(docId)
  }

  /**
   * Deletes a document from the exchange.
   *
   * @param docId - The ID of the document to delete
   */
  async delete(docId: DocId): Promise<void> {
    this.#docCache.delete(docId)
    await this.#synchronizer.removeDocument(docId)
  }

  // =========================================================================
  // PUBLIC API — Adapter management
  // =========================================================================

  /**
   * Add an adapter at runtime.
   * Idempotent: adding an adapter with the same adapterId is a no-op.
   */
  async addAdapter(adapter: AnyAdapter): Promise<void> {
    await this.#synchronizer.addAdapter(adapter)
  }

  /**
   * Remove an adapter at runtime.
   * Idempotent: removing a non-existent adapter is a no-op.
   */
  async removeAdapter(adapterId: string): Promise<void> {
    await this.#synchronizer.removeAdapter(adapterId)
  }

  /**
   * Check if an adapter exists by ID.
   */
  hasAdapter(adapterId: string): boolean {
    return this.#synchronizer.hasAdapter(adapterId)
  }

  /**
   * Get an adapter by ID.
   */
  getAdapter(adapterId: string): AnyAdapter | undefined {
    return this.#synchronizer.getAdapter(adapterId)
  }

  // =========================================================================
  // PUBLIC API — Lifecycle
  // =========================================================================

  /**
   * Await all pending storage operations without disconnecting adapters.
   *
   * Use this when you want to ensure all data has been persisted but
   * plan to continue using the Exchange afterwards.
   */
  async flush(): Promise<void> {
    await this.#synchronizer.flush()
  }

  /**
   * Disconnects all network adapters and cleans up resources.
   *
   * ⚠️ WARNING: This is synchronous and does NOT wait for pending storage
   * saves to complete. If you need to ensure data persistence, use
   * {@link shutdown} instead.
   */
  reset(): void {
    this.#docCache.clear()
    this.#synchronizer.reset()
  }

  /**
   * Gracefully shut down: flush all pending storage operations, then
   * disconnect all adapters and clean up resources.
   *
   * This is the recommended way to stop an Exchange when using persistent
   * storage adapters.
   */
  async shutdown(): Promise<void> {
    this.#docCache.clear()
    await this.#synchronizer.shutdown()
  }

  // =========================================================================
  // Internal access (for testing)
  // =========================================================================

  /** @internal */
  get synchronizer(): Synchronizer {
    return this.#synchronizer
  }
}
