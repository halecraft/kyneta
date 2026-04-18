// line — reliable bidirectional message stream between two Exchange peers.
//
// A Line composes two `json.bind()` authoritative documents — one per direction —
// with automatic sequence numbering, acknowledgement-based pruning, and
// policy-based routing/authorization. The Line class is standalone: it
// composes with the Exchange entirely through public API (register(),
// registerSchema(), get(), dismiss()) — no Exchange modification needed.
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
  change,
  json,
  type Plain,
  Schema,
  type Schema as SchemaNode,
  subscribe,
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
 * The envelope structure (`seq`, `ack`) is an implementation detail of the
 * `Line` class. External consumers interact with `send(msg)` and the async
 * iterator — they never see the envelope fields.
 */
export function createLineDocSchema<S extends SchemaNode>(messageSchema: S) {
  return Schema.struct({
    messages: Schema.list(
      Schema.struct({
        seq: Schema.number(),
        payload: messageSchema,
      }),
    ),
    ack: Schema.number(),
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

/**
 * A reified Line protocol — the schema pair + topic that both sides
 * must agree on to communicate. Created once at module scope, shared
 * between `open()` and `listen()`.
 *
 * Generic parameter ordering: `LineProtocol<ClientMsg, ServerMsg>` names
 * the message types by who *sends* them. `open()` returns
 * `Line<ClientMsg, ServerMsg>` (client sends ClientMsg, receives ServerMsg).
 * `listen()` returns `LineListener<ServerMsg, ClientMsg>` (server sends
 * ServerMsg, receives ClientMsg).
 */
export interface LineProtocol<ClientMsg, ServerMsg> {
  readonly topic: string

  /** Open a Line to a specific peer as the client role. */
  open(exchange: Exchange, peer: string): Line<ClientMsg, ServerMsg>

  /** Listen for incoming Lines as the server role. */
  listen(exchange: Exchange): LineListener<ServerMsg, ClientMsg>
}

/**
 * Handle for reactive acceptance of incoming Lines. Returned by
 * `protocol.listen()`.
 */
export interface LineListener<SendMsg, RecvMsg> {
  readonly topic: string
  onLine(cb: (line: Line<SendMsg, RecvMsg>) => void): () => void
  dispose(): void
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
 * Use `Line.protocol(opts)` to create a protocol, then `protocol.open()`
 * or `protocol.listen()` to create Lines — do not construct directly.
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
export class Line<SendMsg, RecvMsg> {
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
  #closed = false

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

    // Resume persisted protocol state from the outbox document.
    // Zero.structural defaults: Schema.number() → 0.
    // nextSeq 0 means the Line has never sent — start at 1.
    const persistedNextSeq = outbox.nextSeq() as number
    this.#nextSeq = persistedNextSeq || 1
    this.#lastProcessedSeq = outbox.ack() as number

    // Scan for any existing messages (handles reconnection / late open)
    this.#processInbox()

    // Subscribe to inbox changes — dispatch to callbacks and queue
    this.#unsubscribeInbox = subscribe(inbox, (changeset: any) => {
      if (changeset.origin === "local") return // skip our own ack writes
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
    const seq = this.#nextSeq++
    change(this.#outbox, (d: any) => {
      d.messages.push({ seq, payload: msg })
      d.nextSeq.set(this.#nextSeq)
    })
  }

  // -----------------------------------------------------------------------
  // Receive — async iterator
  // -----------------------------------------------------------------------

  /**
   * Async iterator yielding incoming messages in order.
   *
   * This is the sole receive API. All messages — including those that
   * arrived before the Line was constructed (queued by `#processInbox()`
   * in the constructor) — are available through the iterator.
   *
   * Completes (`{ done: true }`) when the Line is closed.
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<RecvMsg> {
    return this.#queue[Symbol.asyncIterator]()
  }

  // -----------------------------------------------------------------------
  // Close / Destroy
  // -----------------------------------------------------------------------

  /**
   * Close the Line — local-only teardown.
   *
   * Releases local resources (iterator, subscriptions, policy, registry)
   * without mutating or deleting the underlying documents. The outbox
   * and inbox documents remain in the Exchange, untouched and available
   * for future resumption via `protocol.open()`.
   *
   * Safe to call at any time — during shutdown, error handling, cleanup.
   * Never poisons the Line's documents for future use.
   */
  close(): void {
    if (this.#closed) return
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
   * Calls `close()` (if not already closed) and then dismisses both
   * underlying documents from the Exchange and any configured stores.
   * After `destroy()`, the Line cannot be resumed — `open()` would
   * create a fresh Line starting at `seq: 1`.
   */
  destroy(): void {
    this.close()
    this.#exchange.dismiss(this.#outboxDocId)
    this.#exchange.dismiss(this.#inboxDocId)
  }

  // -----------------------------------------------------------------------
  // Internal — inbox processing
  // -----------------------------------------------------------------------

  #processInbox(): void {
    if (this.#closed) return

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
        change(this.#outbox, (d: any) => {
          d.ack.set(this.#lastProcessedSeq)
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
    const remoteAck = this.#inbox.ack() as number
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
      change(this.#outbox, (d: any) => {
        d.messages.delete(0, pruneCount)
      })

      // Compact at quiescence — when the outbox is fully drained.
      // This avoids compacting on every ack in high-throughput scenarios.
      // Safety: compact() internally uses leastCommonVersion() as the trim
      // boundary. If no peers are synced, it does full projection — the
      // entirety fallback (§30) ensures reconnecting peers get the full
      // state via exportEntirety(), accepted by the epoch boundary policy
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
   * Called by `protocol.open()` and `protocol.listen()` — never directly
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
    if (getRegistry(exchange).has(key)) {
      throw new Error(
        `Line already open for peer "${remotePeerId}" on topic "${topic}". ` +
          `Close the existing Line before opening a new one.`,
      )
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
      authorize: (
        docId: DocId,
        peer: PeerIdentityDetails,
      ): boolean | undefined => {
        // Outbox: only the local peer can write
        if (docId === outboxDocId) return peer.peerId === exchange.peerId
        // Inbox: affirm the remote peer, abstain for unknowns.
        // Abstain (undefined) instead of veto (false) so that relay
        // topologies work — the relay server's peerId won't match
        // remotePeerId, but the exchange-level authorize can still
        // accept it. Hard veto would block all relay offers.
        // Context: jj:oyouvrss (Phase 4 — authorize gap workaround)
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
   * const line = RPC.open(exchange, "server-peer-id")
   * line.send({ method: "ping", id: 1 })
   *
   * // Server side
   * const listener = RPC.listen(exchange)
   * listener.onLine(line => {
   *   ;(async () => {
   *     for await (const msg of line) { ... }
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

      open(exchange: Exchange, peer: string): Line<any, any> {
        // Client role: sends clientBound, receives serverBound
        return Line.#create(exchange, topic, peer, clientBound, serverBound)
      },

      listen(exchange: Exchange): LineListener<any, any> {
        // 1. Callback management and pending buffer.
        //    Lines created synchronously during registerSchema (step 3)
        //    arrive before the caller has a chance to register onLine
        //    callbacks. We buffer them and replay on the first onLine call.
        const callbacks = new Set<(line: Line<any, any>) => void>()
        let pendingLines: Line<any, any>[] | null = []
        let listenerDisposed = false

        // Unified cleanup — shared by policy dispose hook and manual
        // listener.dispose(). Whoever calls first wins; subsequent
        // calls are no-ops via the listenerDisposed guard.
        function disposeListener(): void {
          if (listenerDisposed) return
          listenerDisposed = true
          callbacks.clear()
          disposePolicy()
        }

        function notifyOrBuffer(line: Line<any, any>): void {
          if (callbacks.size > 0) {
            for (const cb of callbacks) {
              try {
                cb(line)
              } catch {
                // Callback errors don't prevent other callbacks
              }
            }
          } else if (pendingLines) {
            pendingLines.push(line)
          }
        }

        // 2. Register a policy with onDocCreated — BEFORE registerSchema
        //    so that deferred-then-promoted docs (client connected before
        //    listen was called) fire into this handler immediately.
        const disposePolicy = exchange.register({
          name: `__line-listen:${topic}`,
          onDocCreated: (
            docId: DocId,
            _peer: PeerIdentityDetails,
            _mode: "interpret" | "replicate",
            _origin: "local" | "remote",
          ): void => {
            // After dispose, stop accepting new Lines
            if (listenerDisposed) return

            // Parse the doc ID — only react to Line docs
            const parsed = parseLineDocId(docId)
            if (!parsed) return

            // Check: correct topic and addressed to us
            if (parsed.topic !== topic) return
            if (parsed.to !== exchange.peerId) return

            // Duplicate guard: skip if a Line already exists
            const key = registryKey(parsed.from, topic)
            if (getRegistry(exchange).has(key)) return

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
          },
          dispose: () => {
            disposeListener()
          },
        })

        // 3. Register schemas — puts them in the capabilities registry.
        //    Incoming Line docs whose schema hash matches will auto-resolve
        //    in onEnsureDoc step 1, bypassing onUnresolvedDoc.
        //    If any deferred docs match, registerSchema auto-promotes them
        //    synchronously, firing onDocCreated into the policy above.
        //    Any Lines created here are buffered in pendingLines.
        exchange.registerSchema(clientBound)
        if (serverBound !== clientBound) {
          exchange.registerSchema(serverBound)
        }

        // 4. Return the LineListener handle
        return {
          topic,

          onLine(cb: (line: Line<any, any>) => void): () => void {
            callbacks.add(cb)
            // Replay any Lines that arrived during listen() setup
            if (pendingLines && pendingLines.length > 0) {
              const toReplay = pendingLines
              pendingLines = null
              for (const line of toReplay) {
                try {
                  cb(line)
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
