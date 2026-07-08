// line — reliable bidirectional message stream between two Exchange peers.
//
// A Line composes two `json.bind()` authoritative documents — one per direction —
// with automatic sequence numbering, acknowledgement-based pruning, and
// policy-based routing/authorization. The Line class is standalone: it
// composes with the Exchange entirely through public API (register(),
// registerSchema(), get(), destroy()) — no Exchange modification needed.
//
// Protocol-first design: `Line.protocol(opts)` reifies the schema pair +
// topic into a `LineProtocol` object. The protocol's `open()` method creates
// a Line to a specific peer (client role), and `listen()` reactively accepts
// incoming Lines (server role). Both share the same `BoundSchema` references,
// eliminating reference equality conflicts in `exchange.get()`.
//
// Generic strategy: The Line class is parameterized over plain message
// types (SendMsg, RecvMsg) — not schema types — to avoid deep recursive
// expansion of Plain<S>. Schema types appear only in `Line.protocol()`,
// which evaluates `Plain<S>` once via deferred conditional return types.
//
// Context: jj:slsoupsw

import type { BoundSchema } from "@kyneta/schema"
import {
  batch,
  json,
  type Plain,
  Schema,
  type Schema as SchemaNode,
  subscribe,
  version,
} from "@kyneta/schema"
import type { DocId, PeerIdentityDetails } from "@kyneta/transport"
import { AsyncQueue } from "./async-queue.js"
import type { Exchange } from "./exchange.js"

// ---------------------------------------------------------------------------
// Line doc schema factory
// ---------------------------------------------------------------------------

/**
 * Build the invariant envelope schema for a Line document, parameterized
 * by the application's message schema.
 *
 * The envelope structure (`seq`, `ackSeq`, `ackLineage`) is an implementation
 * detail of the `Line` class. `ackLineage` uses `""` as a sentinel for "never acked".
 * External consumers interact with `send(msg)` and the async iterator — they
 * never see the envelope fields.
 */
export function createLineDocSchema<S extends SchemaNode>(messageSchema: S) {
  return Schema.struct({
    messages: Schema.list(
      Schema.struct({
        seq: Schema.number(),
        payload: messageSchema,
      }),
    ),
    ackSeq: Schema.number(),
    ackLineage: Schema.string(),
    nextSeq: Schema.number(),
  })
}

// ---------------------------------------------------------------------------
// Line doc ID utilities
// ---------------------------------------------------------------------------

/**
 * Construct a Line document ID.
 *
 * Format: `line:${topic}:${from}→${to}`
 * The `→` (U+2192) separator is visually clear and unlikely to collide
 * with application doc IDs.
 */
export function lineDocId(topic: string, from: string, to: string): DocId {
  return `line:${topic}:${from}→${to}` as DocId
}

/**
 * Test whether a doc ID is a Line doc ID.
 */
export function isLineDocId(docId: DocId): boolean {
  return docId.startsWith("line:") && docId.includes("→")
}

/**
 * Parse a Line doc ID into its components.
 * Returns `null` if the doc ID is not a valid Line doc ID.
 */
export function parseLineDocId(
  docId: DocId,
): { topic: string; from: string; to: string } | null {
  if (!isLineDocId(docId)) return null
  const body = docId.slice("line:".length)
  const colonIdx = body.indexOf(":")
  if (colonIdx === -1) return null
  const topic = body.slice(0, colonIdx)
  const rest = body.slice(colonIdx + 1)
  const [from, to] = rest.split("→")
  return topic && from && to ? { topic, from, to } : null
}

/**
 * Route predicate for Line docs — returns `true` for endpoint peers,
 * `undefined` for non-Line docs.
 *
 * Exported for advanced consumers (e.g. relay servers) who want to
 * implement custom Line routing in their own policies. Not the primary
 * mechanism — the per-line policy handles authorization automatically.
 */
export function routeLine(
  docId: DocId,
  peer: PeerIdentityDetails,
): boolean | undefined {
  const parsed = parseLineDocId(docId)
  if (!parsed) return undefined
  return peer.peerId === parsed.from || peer.peerId === parsed.to
}

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

/** Symmetric protocol options — same schema both directions. */
type SymmetricProtocolOptions<S extends SchemaNode> = {
  topic: string
  schema: S
}

/** Asymmetric protocol options — client and server send different types. */
type AsymmetricProtocolOptions<C extends SchemaNode, S extends SchemaNode> = {
  topic: string
  client: C // what the client sends (= what the server receives)
  server: S // what the server sends (= what the client receives)
}

// The shared/exclusive capabilities model
// ---------------------------------------------------------------------------

/**
 * The exclusive read capability for a Line.
 *
 * Acquired via `LineProtocol.claimReceiver()`. An `AsyncIterable` — iterate
 * incoming messages with `for await (const msg of receiver)`. Only one
 * iterator may be active at a time. Closing the receiver releases the claim
 * and unhooks the inbox subscriptions, but does not close the sender or
 * destroy the Line.
 */
export interface LineReceiver<RecvMsg> extends AsyncIterable<RecvMsg> {
  readonly topic: string
  readonly peer: string
  readonly closed: boolean
  close(): void
}

/**
 * The shared write capability for a Line.
 *
 * Acquired via `LineProtocol.sender()`. Safe to share across the application
 * (e.g. concurrent RPC senders). Closing the sender decrements its refcount,
 * cleaning up outbox resources when it reaches zero.
 */
export interface LineSender<SendMsg> {
  readonly topic: string
  readonly peer: string
  readonly closed: boolean
  send(msg: SendMsg): void
  close(): void
}

/**
 * A handle to permanently destroy a Line.
 */
export interface LineManager {
  destroy(): void
}

/**
 * Handle for reactive acceptance of incoming Lines. Returned by
 * `protocol.listen()`.
 */
export interface LineListener<SendMsg, RecvMsg> {
  readonly topic: string
  onReceive(
    cb: (
      sender: LineSender<SendMsg>,
      receiver: LineReceiver<RecvMsg>,
      manager: LineManager,
    ) => void,
  ): () => void
  dispose(): void
}

/**
 * A reified Line protocol — the schema pair + topic that both sides
 * must agree on to communicate. Created once at module scope, shared
 * between `sender()`, `claimReceiver()`, and `listen()`.
 */
export interface LineProtocol<ClientMsg, ServerMsg> {
  readonly topic: string

  /**
   * Obtain the shared sender capability for this Line to a specific peer.
   */
  sender(exchange: Exchange, peer: string): LineSender<ClientMsg>

  /**
   * Exclusively claim the read queue for this Line from a specific peer.
   * Throws if another component already holds the receiver.
   */
  claimReceiver(exchange: Exchange, peer: string): LineReceiver<ServerMsg>

  /** permanently destroy a Line, its Outbox, and its Inbox. */
  manager(exchange: Exchange, peer: string): LineManager

  /** Listen for incoming Lines as the server role. */
  listen(exchange: Exchange): LineListener<ServerMsg, ClientMsg>
}

// ---------------------------------------------------------------------------
// CreateProtocol — typed entry point (avoids TS2589)
// ---------------------------------------------------------------------------

// Interface call signature defers Plain<S> evaluation to each call site,
// avoiding TS2589 ("excessively deep") that occurs when Plain<S> appears
// in a generic method return type with abstract S extends SchemaNode.
// Same technique used by createDoc in @kyneta/schema/basic.
interface CreateProtocol {
  <C extends SchemaNode, S extends SchemaNode>(
    opts: AsymmetricProtocolOptions<C, S>,
  ): LineProtocol<Plain<C>, Plain<S>>

  <S extends SchemaNode>(
    opts: SymmetricProtocolOptions<S>,
  ): LineProtocol<Plain<S>, Plain<S>>
}

// ---------------------------------------------------------------------------
// Static state — per-Exchange registry (WeakMap so GC reclaims on dispose)
// ---------------------------------------------------------------------------

/** Open Lines, keyed per-Exchange by `${remotePeerId}:${topic}`. */
const registries = new WeakMap<Exchange, Map<string, Line<any, any>>>()

function getRegistry(exchange: Exchange): Map<string, Line<any, any>> {
  let reg = registries.get(exchange)
  if (!reg) {
    reg = new Map()
    registries.set(exchange, reg)
  }
  return reg
}

function registryKey(remotePeerId: string, topic: string): string {
  return `${remotePeerId}:${topic}`
}

// ---------------------------------------------------------------------------
// Line class
// ---------------------------------------------------------------------------

/**
 * A reliable ordered bidirectional message stream between two Exchange peers.
 *
 * Use `Line.protocol(opts)` to create a protocol, then `protocol.sender()`,
 * `protocol.claimReceiver()`, or `protocol.listen()` to obtain capabilities —
 * do not construct directly.
 *
 * Generic strategy: parameterized over plain message types (`SendMsg`,
 * `RecvMsg`) — not schema types — to avoid deep recursive expansion of
 * `Plain<S>`. `Line.protocol()` evaluates `Plain<S>` once via a deferred
 * conditional return type, and the Line class itself never references
 * `Plain<>`.
 *
 * @typeParam SendMsg - plain type for messages this peer sends
 * @typeParam RecvMsg - plain type for messages this peer receives
 */
export class Line<SendMsg, RecvMsg>
  implements LineSender<SendMsg>, LineReceiver<RecvMsg>, LineManager
{
  readonly #exchange: Exchange
  readonly #topic: string
  readonly #remotePeerId: string
  readonly #outboxDocId: DocId
  readonly #inboxDocId: DocId
  readonly #outbox: any // Ref — untyped to avoid complex generic threading
  readonly #inbox: any // Ref
  readonly #queue: AsyncQueue<RecvMsg>
  readonly #disposePolicy: () => void
  readonly #unsubscribeInbox: () => void
  #nextSeq = 1
  #lastProcessedSeq = 0
  #inboxLineage: string
  #closed = false
  #refCount = 1
  #consumerAttached = false

  /** @internal — use `Line.protocol()` instead. */
  constructor(
    exchange: Exchange,
    topic: string,
    remotePeerId: string,
    outboxDocId: DocId,
    inboxDocId: DocId,
    outbox: any,
    inbox: any,
    disposePolicy: () => void,
  ) {
    this.#exchange = exchange
    this.#topic = topic
    this.#remotePeerId = remotePeerId
    this.#outboxDocId = outboxDocId
    this.#inboxDocId = inboxDocId
    this.#outbox = outbox
    this.#inbox = inbox
    this.#disposePolicy = disposePolicy
    this.#queue = new AsyncQueue<RecvMsg>()

    this.#inboxLineage = version(inbox).lineage

    // Resume persisted protocol state from the outbox document.
    // Zero.structural defaults: Schema.number() → 0.
    // nextSeq 0 means the Line has never sent — start at 1.
    const persistedNextSeq = outbox.nextSeq() as number
    this.#nextSeq = persistedNextSeq || 1

    const ackLineage = outbox.ackLineage() as string
    if (ackLineage === this.#inboxLineage) {
      this.#lastProcessedSeq = outbox.ackSeq() as number
    } else {
      this.#lastProcessedSeq = 0
    }

    // Scan for any existing messages (handles reconnection / late open)
    this.#processInbox()

    // Subscribe to inbox changes — dispatch to callbacks and queue.
    // The Line never writes to its own inbox locally; inbox changes are
    // delivered exclusively by the substrate event bridge (replay path).
    // No echo-suppression filter is needed here.
    this.#unsubscribeInbox = subscribe(inbox, () => {
      this.#processInbox()
    })
  }

  /** The topic for this Line. */
  get topic(): string {
    return this.#topic
  }

  /** The remote peer ID. */
  get peer(): string {
    return this.#remotePeerId
  }

  /** Whether this Line has been closed. */
  get closed(): boolean {
    return this.#closed
  }

  // -----------------------------------------------------------------------
  // Send
  // -----------------------------------------------------------------------

  /**
   * Send a message to the remote peer.
   *
   * The message is type-checked against the send schema at compile time.
   * Internally appends `{ seq, payload }` to the outbox doc's `messages`
   * list. The Exchange's changefeed → synchronizer wiring pushes it to
   * the remote peer.
   */
  send(msg: SendMsg): void {
    if (this.#closed) {
      throw new Error("Cannot send on a closed Line")
    }
    batch(this.#outbox, (d: any) => {
      // Always read from doc to handle sync updates (e.g. restart recovery)
      const persistedNextSeq = (d.nextSeq() as number) || 1

      const seq = persistedNextSeq

      this.#nextSeq = seq + 1
      d.messages.push({ seq, payload: msg })
      d.nextSeq.set(this.#nextSeq)
    })
  }

  // -----------------------------------------------------------------------
  // Receive — exclusive async iterator
  // -----------------------------------------------------------------------

  /**
   * Iterate incoming messages. Returns an async iterator yielding messages
   * as they arrive. This is the sole receive API — a Line can only be
   * iterated by one caller at a time.
   *
   * Completes (`{ done: true }`) when the Line is closed.
   */
  [Symbol.asyncIterator](): AsyncIterator<RecvMsg> {
    if (this.#consumerAttached) {
      throw new Error("Line is already being iterated")
    }
    this.#consumerAttached = true
    return this.#queue[Symbol.asyncIterator]()
  }

  // -----------------------------------------------------------------------
  // Close / Destroy
  // -----------------------------------------------------------------------

  /**
   * Close the Line — decrements the reference count.
   *
   * When the reference count reaches zero, releases local resources
   * (iterator, subscriptions, policy, registry) without mutating or
   * deleting the underlying documents. The outbox and inbox documents
   * remain in the Exchange, untouched and available for future resumption
   * via `protocol.sender()` or `protocol.claimReceiver()`.
   *
   * Safe to call at any time — during shutdown, error handling, cleanup.
   * Never poisons the Line's documents for future use.
   */
  close(): void {
    if (this.#closed) return
    this.#refCount--
    if (this.#refCount > 0) return

    this.#closed = true

    this.#queue.close()
    this.#unsubscribeInbox()
    this.#disposePolicy()

    // Remove from registry — allows re-opening the same peer+topic
    const key = registryKey(this.#remotePeerId, this.#topic)
    getRegistry(this.#exchange).delete(key)
  }

  /**
   * Destroy the Line — permanent teardown.
   *
   * Forces the reference count to zero, calls `close()`, and then
   * destroys both underlying documents from the Exchange and any
   * configured stores. After `destroy()`, the Line cannot be resumed —
   * `open()` would create a fresh Line starting at `seq: 1`.
   */
  destroy(): void {
    this.#refCount = 1 // Force close to actually tear down
    this.close()
    this.#exchange.destroy(this.#outboxDocId)
    this.#exchange.destroy(this.#inboxDocId)
  }

  // -----------------------------------------------------------------------
  // Internal — inbox processing
  // -----------------------------------------------------------------------

  #processInbox(): void {
    if (this.#closed) return

    const currentInboxLineage = version(this.#inbox).lineage

    if (currentInboxLineage !== this.#inboxLineage) {
      this.#lastProcessedSeq = 0
      this.#inboxLineage = currentInboxLineage
    }

    // Read all messages from inbox — inbox is any-typed, so messages are any[]
    const messages: any[] = this.#inbox.messages()

    let advanced = false
    if (messages && messages.length > 0) {
      for (const msg of messages) {
        if (msg.seq <= this.#lastProcessedSeq) continue

        this.#queue.push(msg.payload)

        this.#lastProcessedSeq = msg.seq
        advanced = true
      }

      if (advanced) {
        // Write ack to outbox
        batch(this.#outbox, (d: any) => {
          d.ackSeq.set(this.#lastProcessedSeq)
          d.ackLineage.set(this.#inboxLineage)
        })
      }
    }

    // Always check for pruning — the inbox ack field may have advanced
    // even when no new messages arrived (e.g. unidirectional flow where
    // the remote only acks, never sends). Without this, the sender's
    // outbox grows without bound.
    this.#pruneOutbox()
  }

  #pruneOutbox(): void {
    const currentOutboxLineage = version(this.#outbox).lineage

    const ackLineage = this.#inbox.ackLineage() as string
    if (ackLineage !== currentOutboxLineage) return

    const remoteAck = this.#inbox.ackSeq() as number
    if (remoteAck <= 0) return

    const messages: any[] = this.#outbox.messages()
    if (!messages || messages.length === 0) return

    // Count how many messages from the front have been acked
    let pruneCount = 0
    for (const msg of messages) {
      if (msg.seq <= remoteAck) {
        pruneCount++
      } else {
        break
      }
    }

    if (pruneCount > 0) {
      batch(this.#outbox, (d: any) => {
        d.messages.delete(0, pruneCount)
      })

      // Compact at quiescence — when the outbox is fully drained.
      // This avoids compacting on every ack in high-throughput scenarios.
      // Safety: compact() internally uses leastCommonVersion() as the trim
      // boundary. If no peers are synced, it does full projection — the
      // entirety fallback (§30) ensures reconnecting peers get the full
      // state via exportEntirety(), accepted by the lineage boundary policy
      // (§29, default: accept for authoritative strategy).
      // Fire-and-forget: compaction failure is non-fatal.
      if (this.#outbox.messages().length === 0) {
        this.#exchange.compact(this.#outboxDocId).catch(() => {})
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal — shared Line construction
  // -----------------------------------------------------------------------

  /**
   * Create a Line from pre-resolved BoundSchema references.
   *
   * Performs the core construction: duplicate check, doc ID computation,
   * `exchange.get()`, per-line policy registration, instance construction,
   * and registry insertion.
   *
   * Called by `protocol.sender()`, `protocol.claimReceiver()`,
   * `protocol.manager()`, and `protocol.listen()` — never directly
   * by external consumers.
   *
   * @internal
   */
  static #create(
    exchange: Exchange,
    topic: string,
    remotePeerId: string,
    outboxBound: BoundSchema,
    inboxBound: BoundSchema,
  ): Line<any, any> {
    // 1. Check for duplicate
    const key = registryKey(remotePeerId, topic)
    const existing = getRegistry(exchange).get(key)
    if (existing) {
      existing.#refCount++
      return existing
    }

    // 2. Compute doc IDs
    const outboxDocId = lineDocId(topic, exchange.peerId, remotePeerId)
    const inboxDocId = lineDocId(topic, remotePeerId, exchange.peerId)

    // 3. Create docs via exchange.get()
    // Registration happens inside get() — no separate registerSchema() needed
    // for the open() path. For the listen() path, registerSchema() is called
    // before #create() so auto-resolve works.
    // Cast to any — the Line class manages refs internally and doesn't
    // expose them. Avoids deep type expansion through Ref<DocSchema<...>>.
    const outbox: any = (exchange as any).get(outboxDocId, outboxBound)
    const inbox: any = (exchange as any).get(inboxDocId, inboxBound)

    // 4. Register per-line named policy with dispose hook.
    //    The mutable cell lets the dispose callback reference the Line
    //    without reordering construction (policy is registered before
    //    the Line instance exists). The ?.close() guard handles the
    //    impossible-in-practice case where dispose fires mid-#create().
    const cell = { line: null as Line<any, any> | null }
    const disposePolicy = exchange.register({
      name: `line:${topic}:${remotePeerId}`,
      canAccept: (
        docId: DocId,
        peer: PeerIdentityDetails,
      ): boolean | undefined => {
        // Outbox: only the local peer can write
        if (docId === outboxDocId) return peer.peerId === exchange.peerId
        // Inbox: affirm the remote peer, abstain for unknowns.
        // Abstain (undefined) instead of veto (false) so that relay
        // topologies work — the relay server's peerId won't match
        // remotePeerId, but the exchange-level canAccept can still
        // accept it. Hard veto would block all relay offers.
        // Context: jj:oyouvrss (Phase 4 — canAccept gap workaround)
        if (docId === inboxDocId)
          return peer.peerId === remotePeerId ? true : undefined
        return undefined
      },
      dispose: () => {
        cell.line?.close()
      },
    })

    // 5. Construct and register
    const line = new Line(
      exchange,
      topic,
      remotePeerId,
      outboxDocId,
      inboxDocId,
      outbox,
      inbox,
      disposePolicy,
    )

    cell.line = line
    getRegistry(exchange).set(key, line)
    return line
  }

  // -----------------------------------------------------------------------
  // Static — protocol factory
  // -----------------------------------------------------------------------

  /**
   * Create a Line protocol — a reified schema pair + topic.
   *
   * The protocol object is small and pure: it holds the topic string and
   * one or two `BoundSchema` references. It has no mutable state. Create
   * it at module scope and share between `open()` and `listen()` calls.
   *
   * @example
   * ```ts
   * // Symmetric — same schema both directions
   * const Chat = Line.protocol({ topic: "chat", schema: MessageSchema })
   *
   * // Asymmetric — client and server send different types
   * const RPC = Line.protocol({
   *   topic: "rpc",
   *   client: RequestSchema,
   *   server: ResponseSchema,
   * })
   *
   * // Client side
   * const sender = RPC.sender(exchange, "server-peer-id")
   * const receiver = RPC.claimReceiver(exchange, "server-peer-id")
   * sender.send({ method: "ping", id: 1 })
   *
   * // Server side
   * const listener = RPC.listen(exchange)
   * listener.onReceive((sender, receiver) => {
   *   ;(async () => {
   *     for await (const msg of receiver) { ... }
   *   })()
   * })
   * ```
   */
  static protocol = ((opts: any) => {
    const topic = opts.topic

    // Resolve schemas: symmetric uses one BoundSchema for both directions;
    // asymmetric creates two distinct BoundSchema objects.
    // For symmetric protocols, a single json.bind() call is essential —
    // two calls produce distinct references with the same schemaHash, and
    // the capabilities registry overwrites on duplicate hashes. Using the
    // same reference ensures exchange.get() reference equality is satisfied.
    let clientBound: BoundSchema
    let serverBound: BoundSchema
    if ("schema" in opts) {
      const bound = json.bind(createLineDocSchema(opts.schema))
      clientBound = bound
      serverBound = bound
    } else {
      clientBound = json.bind(createLineDocSchema(opts.client))
      serverBound = json.bind(createLineDocSchema(opts.server))
    }

    return {
      topic,

      sender(exchange: Exchange, peer: string): LineSender<any> {
        // Client role: sends clientBound, receives serverBound
        return Line.#create(exchange, topic, peer, clientBound, serverBound)
      },

      claimReceiver(exchange: Exchange, peer: string): LineReceiver<any> {
        const line = Line.#create(
          exchange,
          topic,
          peer,
          clientBound,
          serverBound,
        )
        return {
          topic: line.topic,
          peer: line.peer,
          get closed() {
            return line.closed
          },
          [Symbol.asyncIterator]: () => line[Symbol.asyncIterator](),
          close: () => line.close(),
        }
      },

      manager(exchange: Exchange, peer: string): LineManager {
        const line = Line.#create(
          exchange,
          topic,
          peer,
          clientBound,
          serverBound,
        )
        return {
          destroy: () => line.destroy(),
        }
      },

      listen(exchange: Exchange): LineListener<any, any> {
        // 1. Callback management and pending buffer.
        //    Lines created synchronously during registerSchema (step 3)
        //    arrive before the caller has a chance to register onLine
        //    callbacks. We buffer them and replay on the first onLine call.
        const callbacks = new Set<
          (
            sender: LineSender<any>,
            receiver: LineReceiver<any>,
            manager: LineManager,
          ) => void
        >()
        let pendingLines: Line<any, any>[] | null = []
        let listenerDisposed = false

        // Unified cleanup — shared by subscription unsubscribe and manual
        // listener.dispose(). Whoever calls first wins; subsequent
        // calls are no-ops via the listenerDisposed guard.
        let unsubscribeDocs: (() => void) | null = null
        function disposeListener(): void {
          if (listenerDisposed) return
          listenerDisposed = true
          callbacks.clear()
          unsubscribeDocs?.()
        }

        function notifyOrBuffer(line: Line<any, any>): void {
          if (callbacks.size > 0) {
            const sender = line
            const receiver = {
              topic: line.topic,
              peer: line.peer,
              get closed() {
                return line.closed
              },
              [Symbol.asyncIterator]: () => line[Symbol.asyncIterator](),
              close: () => line.close(),
            }
            const manager = {
              destroy: () => line.destroy(),
            }
            for (const cb of callbacks) {
              try {
                cb(sender, receiver, manager)
              } catch {
                // Callback errors don't prevent other callbacks
              }
            }
          } else if (pendingLines) {
            pendingLines.push(line)
          }
        }

        // 2. Subscribe to the documents feed to detect newly created docs.
        //    When a doc is created (local get(), remote auto-resolve, or
        //    deferred-then-promoted), we check if it's a Line doc addressed
        //    to us and create the server-side Line.
        //
        //    This replaces the old onDocCreated policy callback which was
        //    removed in the governance reform. The documents feed emits
        //    doc-created events from the same registerDoc() code path.
        unsubscribeDocs = exchange.documents.subscribe(changeset => {
          for (const change of changeset.changes) {
            if (change.type !== "doc-created") continue
            const docId = change.docId

            // After dispose, stop accepting new Lines
            if (listenerDisposed) return

            // Parse the doc ID — only react to Line docs
            const parsed = parseLineDocId(docId)
            if (!parsed) continue

            // Check: correct topic and addressed to us
            if (parsed.topic !== topic) continue
            if (parsed.to !== exchange.peerId) continue

            // Duplicate guard: skip if a Line already exists
            const key = registryKey(parsed.from, topic)
            if (getRegistry(exchange).has(key)) continue

            // Create the server-side Line: server sends serverBound,
            // receives clientBound (the reverse of the client role)
            const line = Line.#create(
              exchange,
              topic,
              parsed.from,
              serverBound,
              clientBound,
            )

            notifyOrBuffer(line)
          }
        })

        // 3. Register schemas — puts them in the capabilities registry.
        //    Incoming Line docs whose schema hash matches will auto-resolve
        //    in onEnsureDoc step 1, bypassing resolve.
        //    If any deferred docs match, registerSchema auto-promotes them
        //    synchronously (adds to #docCache), but the documents feed
        //    fires at quiescence — so the subscription above won't see
        //    them yet. Step 3b scans existing docs to catch them.
        exchange.registerSchema(clientBound)
        if (serverBound !== clientBound) {
          exchange.registerSchema(serverBound)
        }

        // 3b. Scan existing documents to catch docs that were promoted
        //     synchronously by registerSchema above. The documents feed
        //     subscription (step 2) fires at quiescence, so it misses
        //     docs created during the synchronous registerSchema call.
        //     This two-phase pattern (subscribe + scan) mirrors Source.of.
        for (const [docId] of exchange.documents()) {
          if (listenerDisposed) break

          const parsed = parseLineDocId(docId)
          if (!parsed) continue
          if (parsed.topic !== topic) continue
          if (parsed.to !== exchange.peerId) continue

          const key = registryKey(parsed.from, topic)
          if (getRegistry(exchange).has(key)) continue

          const line = Line.#create(
            exchange,
            topic,
            parsed.from,
            serverBound,
            clientBound,
          )

          notifyOrBuffer(line)
        }

        // 4. Return the LineListener handle
        return {
          topic,

          onReceive(
            cb: (
              sender: LineSender<any>,
              receiver: LineReceiver<any>,
              manager: LineManager,
            ) => void,
          ): () => void {
            callbacks.add(cb)
            // Replay any Lines that arrived during listen() setup
            if (pendingLines && pendingLines.length > 0) {
              const toReplay = pendingLines
              pendingLines = null
              for (const line of toReplay) {
                const sender = line
                const receiver = {
                  topic: line.topic,
                  peer: line.peer,
                  get closed() {
                    return line.closed
                  },
                  [Symbol.asyncIterator]: () => line[Symbol.asyncIterator](),
                  close: () => line.close(),
                }
                const manager = {
                  destroy: () => line.destroy(),
                }
                try {
                  cb(sender, receiver, manager)
                } catch {
                  // Callback errors don't prevent replay
                }
              }
            } else {
              pendingLines = null
            }
            return () => {
              callbacks.delete(cb)
            }
          },

          dispose(): void {
            disposeListener()
          },
        }
      },
    }
  }) as any as CreateProtocol
}
