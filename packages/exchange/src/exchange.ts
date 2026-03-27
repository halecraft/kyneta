// exchange — the public API for @kyneta/exchange.
//
// The Exchange class is the central orchestrator for substrate-agnostic
// state synchronization. It manages document lifecycle, coordinates
// adapters, and provides the main API for document operations.
//
// Usage:
//   const exchange = new Exchange({
//     identity: { name: "alice" },
//     adapters: [network, storage],
//     substrates: { loro: loroFactory, plain: plainFactory },
//     defaultSubstrate: "loro",
//   })
//
//   const doc = exchange.get("my-doc", schema)
//   sync(doc).waitForSync()

import {
  interpret,
  type Ref,
  type Schema as SchemaNode,
} from "@kyneta/schema"
import { changefeed, readable, writable } from "@kyneta/schema"
import type { AnyAdapter } from "./adapter/adapter.js"
import type { ExchangeSubstrateFactory } from "./factory.js"
import type { Permissions } from "./permissions.js"
import { registerSync } from "./sync.js"
import { Synchronizer } from "./synchronizer.js"
import type { DocId, PeerIdentityDetails } from "./types.js"
import { generatePeerId, validatePeerId } from "./utils.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
   * Named substrate factories. Each key is a substrate type name
   * (e.g. "loro", "plain", "lww") and each value is an
   * ExchangeSubstrateFactory that knows how to create substrates
   * of that type.
   *
   * The exchange calls `_initialize({ peerId })` on each factory
   * during construction, injecting the exchange's peer identity.
   */
  substrates: Record<string, ExchangeSubstrateFactory<any>>

  /**
   * Default substrate type. When `get()` is called without an
   * explicit `substrate` option, this key is used to look up the
   * factory. If omitted and there is exactly one substrate, that
   * one is used as the default.
   */
  defaultSubstrate?: string

  /**
   * Permission predicates controlling document access.
   */
  permissions?: Partial<Permissions>
}

/**
 * Options for `exchange.get()`.
 */
export type GetOptions = {
  /**
   * Which substrate factory to use (key into the `substrates` record).
   * Falls back to `defaultSubstrate` if omitted.
   */
  substrate?: string

  /**
   * Optional seed values for the initial document state.
   */
  seed?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Doc cache entry
// ---------------------------------------------------------------------------

type DocCacheEntry = {
  ref: any
  schema: SchemaNode
  substrateName: string
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
 * simultaneously (heterogeneous documents).
 *
 * @example
 * ```typescript
 * const exchange = new Exchange({
 *   identity: { name: "alice" },
 *   adapters: [new BridgeAdapter({ adapterType: "peer-a", bridge })],
 *   substrates: { plain: plainFactory, loro: loroFactory },
 *   defaultSubstrate: "plain",
 * })
 *
 * const doc = exchange.get("my-doc", mySchema)
 * doc.title()  // read
 * change(doc, d => d.title.set("Hello"))  // write
 * await sync(doc).waitForSync()  // sync
 * ```
 */
export class Exchange {
  readonly peerId: string

  readonly #synchronizer: Synchronizer
  readonly #substrates: Record<string, ExchangeSubstrateFactory<any>>
  readonly #defaultSubstrate: string | undefined
  readonly #docCache = new Map<DocId, DocCacheEntry>()

  constructor({
    identity = {},
    adapters = [],
    substrates,
    defaultSubstrate,
    permissions,
  }: ExchangeParams) {
    // Resolve peer identity
    const peerId = identity.peerId ?? generatePeerId()
    validatePeerId(peerId)
    this.peerId = peerId

    const fullIdentity: PeerIdentityDetails = {
      peerId,
      name: identity.name,
      type: identity.type ?? "user",
    }

    // Store substrate factories
    this.#substrates = substrates

    // Resolve default substrate
    const substrateKeys = Object.keys(substrates)
    if (defaultSubstrate) {
      if (!(defaultSubstrate in substrates)) {
        throw new Error(
          `defaultSubstrate '${defaultSubstrate}' not found in substrates. ` +
            `Available: ${substrateKeys.join(", ")}`,
        )
      }
      this.#defaultSubstrate = defaultSubstrate
    } else if (substrateKeys.length === 1) {
      this.#defaultSubstrate = substrateKeys[0]
    } else {
      this.#defaultSubstrate = undefined
    }

    // Initialize all factories with peer identity
    for (const factory of Object.values(substrates)) {
      factory._initialize({ peerId })
    }

    // Create synchronizer
    this.#synchronizer = new Synchronizer({
      identity: fullIdentity,
      adapters,
      permissions,
    })
  }

  // =========================================================================
  // PUBLIC API — Document access
  // =========================================================================

  /**
   * Gets (or creates) a document with typed schema.
   *
   * This is the primary API for accessing documents. Returns a full-stack
   * `Ref<S>` — callable, navigable, writable, transactable, and observable.
   *
   * The ref is backed by a substrate determined by `opts.substrate` (or
   * the default substrate). The substrate's merge strategy determines how
   * the exchange syncs this document with peers.
   *
   * Multiple calls with the same `docId` return the same instance.
   * Calling with a different schema for the same `docId` throws.
   *
   * @param docId - The document ID
   * @param schema - The schema describing the document structure
   * @param opts - Options (substrate selection, seed values)
   * @returns A full-stack Ref<S> with sync capabilities via `sync()`
   *
   * @example
   * ```typescript
   * const doc = exchange.get("my-doc", mySchema)
   * doc.title()  // read via ref
   *
   * // With explicit substrate
   * const doc2 = exchange.get("config", configSchema, { substrate: "plain" })
   *
   * // With seed values
   * const doc3 = exchange.get("new-doc", mySchema, { seed: { title: "Hello" } })
   * ```
   */
  get<S extends SchemaNode>(
    docId: DocId,
    schema: S,
    opts?: GetOptions,
  ): Ref<S> {
    // Check cache first
    const cached = this.#docCache.get(docId)

    if (cached) {
      // Validate schema matches — throw if different schema for same docId
      if (cached.schema !== schema) {
        throw new Error(
          `Document '${docId}' already exists with a different schema. ` +
            `Use the same schema object when calling exchange.get() for the same document.`,
        )
      }

      return cached.ref as Ref<S>
    }

    // Resolve factory
    const substrateName = opts?.substrate ?? this.#defaultSubstrate
    if (!substrateName) {
      throw new Error(
        "No substrate specified and no default substrate configured. " +
          "Either pass { substrate: 'name' } to get() or set defaultSubstrate in the Exchange constructor.",
      )
    }

    const factory = this.#substrates[substrateName]
    if (!factory) {
      throw new Error(
        `Substrate '${substrateName}' not found. ` +
          `Available: ${Object.keys(this.#substrates).join(", ")}`,
      )
    }

    // Create substrate
    const seed = opts?.seed ?? {}
    const substrate = factory.create(schema, seed)

    // Build the full interpreter stack
    // The `as any` avoids TS2589 — interpret's fluent API produces deeply
    // recursive types when S is the abstract SchemaNode. The public
    // get<S>() signature provides the correct Ref<S> return type.
    const ref: any = (interpret as any)(schema, substrate.context())
      .with(readable)
      .with(writable)
      .with(changefeed)
      .done()

    // Register sync capabilities
    registerSync(ref, {
      peerId: this.peerId,
      docId,
      synchronizer: this.#synchronizer,
    })

    // Cache
    this.#docCache.set(docId, {
      ref,
      schema,
      substrateName,
    })

    // Register with synchronizer
    this.#synchronizer.registerDoc({
      docId,
      substrate,
      factory,
      ref,
      schema,
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