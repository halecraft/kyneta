// line — reliable bidirectional message stream between two Exchange peers.
//
// A Line composes two `bindPlain` sequential documents — one per direction —
// with automatic sequence numbering, acknowledgement-based pruning, and
// scope-based routing/authorization. The Line class is standalone: it
// composes with the Exchange entirely through public API (register(),
// registerSchema(), get(), dismiss()) — no Exchange modification needed.
//
// Generic strategy: The Line class is parameterized over plain message
// types (SendMsg, RecvMsg) — not schema types — to avoid deep recursive
// expansion of Plain<S>. Schema types appear only in Line.open(), which
// evaluates Plain<S> once and threads the result into the constructor.
//
// Context: jj:slsoupsw

import type { CallableChangefeed } from "@kyneta/changefeed"
import {
  type BoundSchema,
  bindPlain,
  change,
  Defer,
  type Plain,
  Schema,
  type Schema as SchemaNode,
  subscribe,
} from "@kyneta/schema"
import type { DocId, PeerIdentityDetails } from "@kyneta/transport"
import { AsyncQueue } from "./async-queue.js"
import type { Exchange } from "./exchange.js"
import type { PeerChange } from "./types.js"

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
  return Schema.doc({
    messages: Schema.list(
      Schema.struct({
        seq: Schema.number(),
        payload: messageSchema,
      }),
    ),
    ack: Schema.number(),
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
 * implement custom Line routing in their own scopes. Not the primary
 * mechanism — the per-line scope handles authorization automatically.
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
// LineOptions — discriminated union for Line.open()
// ---------------------------------------------------------------------------

/** Symmetric Line options — same schema both directions. */
type SymmetricLineOptions<S extends SchemaNode> = {
  peer: string
  topic?: string
  schema: S
}

/** Asymmetric Line options — different schemas per direction. */
type AsymmetricLineOptions<Send extends SchemaNode, Recv extends SchemaNode> = {
  peer: string
  topic?: string
  send: Send
  recv: Recv
}

/** Options for `Line.open()`. */
export type LineOptions<Send extends SchemaNode, Recv extends SchemaNode> =
  | SymmetricLineOptions<Send & Recv>
  | AsymmetricLineOptions<Send, Recv>

// ---------------------------------------------------------------------------
// Static state — registry and infrastructure scope tracking
// ---------------------------------------------------------------------------

/** Open Lines, keyed by `${exchangePeerId}:${remotePeerId}:${topic}`. */
const registry = new Map<string, Line<any, any>>()

/** Exchanges that have the infrastructure scope registered. */
const infrastructureScopes = new WeakSet<Exchange>()

function registryKey(
  exchangePeerId: string,
  remotePeerId: string,
  topic: string,
): string {
  return `${exchangePeerId}:${remotePeerId}:${topic}`
}

// ---------------------------------------------------------------------------
// Line class
// ---------------------------------------------------------------------------

/**
 * A reliable ordered bidirectional message stream between two Exchange peers.
 *
 * Use `Line.open(exchange, opts)` to create — do not construct directly.
 *
 * Generic strategy: parameterized over plain message types (`SendMsg`,
 * `RecvMsg`) — not schema types — to avoid deep recursive expansion of
 * `Plain<S>`. `Line.open()` evaluates `Plain<S>` once via a deferred
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
  readonly #outboxBound: BoundSchema
  readonly #inboxBound: BoundSchema
  readonly #queue: AsyncQueue<RecvMsg>
  readonly #onReceiveCallbacks = new Set<(msg: RecvMsg) => void>()
  readonly #disposeScope: () => void
  readonly #unsubscribeInbox: () => void
  readonly #unsubscribePeers: () => void
  #nextSeq = 1
  #lastProcessedSeq = 0
  #closed = false

  /** @internal — use `Line.open()` instead. */
  constructor(
    exchange: Exchange,
    topic: string,
    remotePeerId: string,
    outboxDocId: DocId,
    inboxDocId: DocId,
    outbox: any,
    inbox: any,
    outboxBound: BoundSchema,
    inboxBound: BoundSchema,
    disposeScope: () => void,
  ) {
    this.#exchange = exchange
    this.#topic = topic
    this.#remotePeerId = remotePeerId
    this.#outboxDocId = outboxDocId
    this.#inboxDocId = inboxDocId
    this.#outbox = outbox
    this.#inbox = inbox
    this.#outboxBound = outboxBound
    this.#inboxBound = inboxBound
    this.#disposeScope = disposeScope
    this.#queue = new AsyncQueue<RecvMsg>()

    // Scan for any existing messages (handles reconnection / late open)
    this.#processInbox()

    // Subscribe to inbox changes — dispatch to callbacks and queue
    this.#unsubscribeInbox = subscribe(inbox, (changeset: any) => {
      if (changeset.origin === "local") return // skip our own ack writes
      this.#processInbox()
    })

    // Subscribe to peer lifecycle — complete on remote peer departure
    this.#unsubscribePeers = (
      exchange.peers as CallableChangefeed<any, PeerChange>
    ).subscribe((cs: any) => {
      for (const c of cs.changes) {
        if (c.type === "peer-left" && c.peer.peerId === remotePeerId) {
          this.close()
          return
        }
      }
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
    })
  }

  // -----------------------------------------------------------------------
  // Receive — push-based callback
  // -----------------------------------------------------------------------

  /**
   * Register a push-based callback for incoming messages.
   * Returns an unsubscribe function.
   *
   * Multiple callbacks can coexist. Each sees every message.
   * Coexists with the async generator — both share one ack cursor.
   */
  onReceive(cb: (msg: RecvMsg) => void): () => void {
    if (this.#closed) {
      throw new Error("Cannot register onReceive on a closed Line")
    }
    this.#onReceiveCallbacks.add(cb)
    return () => {
      this.#onReceiveCallbacks.delete(cb)
    }
  }

  // -----------------------------------------------------------------------
  // Receive — pull-based async generator
  // -----------------------------------------------------------------------

  /**
   * Async iterator yielding incoming messages.
   *
   * Completes (`{ done: true }`) when the Line is closed or the remote
   * peer departs.
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<RecvMsg> {
    return this.#queue[Symbol.asyncIterator]()
  }

  // -----------------------------------------------------------------------
  // Close
  // -----------------------------------------------------------------------

  /**
   * Close the Line.
   *
   * 1. Marks closed.
   * 2. Clears all `onReceive` callbacks.
   * 3. Completes the async iterator.
   * 4. Disposes the per-line scope.
   * 5. Dismisses both underlying docs.
   * 6. Removes from the static registry.
   */
  close(): void {
    if (this.#closed) return
    this.#closed = true

    this.#onReceiveCallbacks.clear()
    this.#queue.close()
    this.#unsubscribeInbox()
    this.#unsubscribePeers()
    this.#disposeScope()

    // Dismiss underlying docs
    this.#exchange.dismiss(this.#outboxDocId)
    this.#exchange.dismiss(this.#inboxDocId)

    // Remove from registry
    const key = registryKey(
      this.#exchange.peerId,
      this.#remotePeerId,
      this.#topic,
    )
    registry.delete(key)
  }

  // -----------------------------------------------------------------------
  // Internal — inbox processing
  // -----------------------------------------------------------------------

  #processInbox(): void {
    if (this.#closed) return

    // Read all messages from inbox — inbox is any-typed, so messages are any[]
    const messages: any[] = this.#inbox.messages()
    if (!messages || messages.length === 0) return

    let advanced = false
    for (const msg of messages) {
      if (msg.seq <= this.#lastProcessedSeq) continue

      // Dispatch to onReceive callbacks
      for (const cb of this.#onReceiveCallbacks) {
        try {
          cb(msg.payload)
        } catch {
          // Callback errors don't prevent ack advancement
        }
      }

      // Enqueue for async iterator
      this.#queue.push(msg.payload)

      this.#lastProcessedSeq = msg.seq
      advanced = true
    }

    if (advanced) {
      // Write ack to outbox
      change(this.#outbox, (d: any) => {
        d.ack.set(this.#lastProcessedSeq)
      })

      // Check for pruning opportunity — read remote ack from inbox
      this.#pruneOutbox()
    }
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
    }
  }

  // -----------------------------------------------------------------------
  // Static factory
  // -----------------------------------------------------------------------

  /**
   * Open a Line to a remote peer.
   *
   * @param exchange - The Exchange instance to compose with.
   * @param opts - Line options (peer, topic, schema or send/recv).
   *
   * @example
   * ```ts
   * // Symmetric — same schema both directions
   * const line = Line.open(exchange, { peer: "bob", schema: SignalSchema })
   *
   * // Asymmetric — different schemas per direction
   * const line = Line.open(exchange, {
   *   peer: "server",
   *   topic: "rpc",
   *   send: RequestSchema,
   *   recv: ResponseSchema,
   * })
   * ```
   *
   * @throws If a Line with the same `peer` and `topic` is already open.
   */
  static open(exchange: Exchange, opts: LineOptions<any, any>): Line<any, any> {
    const topic = opts.topic ?? "default"
    const remotePeerId = opts.peer

    // 1. Check for duplicate
    const key = registryKey(exchange.peerId, remotePeerId, topic)
    if (registry.has(key)) {
      throw new Error(
        `Line already open for peer "${remotePeerId}" on topic "${topic}". ` +
          `Close the existing Line before opening a new one.`,
      )
    }

    // 2. Infrastructure scope (idempotent via named scope replacement)
    if (!infrastructureScopes.has(exchange)) {
      exchange.register({
        name: "__line-infrastructure",
        classify: (
          docId: DocId,
          _peer: PeerIdentityDetails,
          _replicaType: any,
          _mergeStrategy: any,
          _schemaHash: string,
        ) => {
          return isLineDocId(docId) ? Defer() : undefined
        },
      })
      infrastructureScopes.add(exchange)
    }

    // 3. Compute doc IDs
    const outboxDocId = lineDocId(topic, exchange.peerId, remotePeerId)
    const inboxDocId = lineDocId(topic, remotePeerId, exchange.peerId)

    // 4. Resolve schemas
    const sendSchema =
      "send" in opts ? opts.send : (opts as SymmetricLineOptions<any>).schema
    const recvSchema =
      "recv" in opts ? opts.recv : (opts as SymmetricLineOptions<any>).schema

    const outboxBound = bindPlain(createLineDocSchema(sendSchema))
    const inboxBound = bindPlain(createLineDocSchema(recvSchema))

    // 5. Register schemas (populates capabilities, auto-promotes deferred docs)
    exchange.registerSchema(outboxBound)
    exchange.registerSchema(inboxBound)

    // 6-7. Create docs via exchange.get()
    // Cast to any — the Line class manages refs internally and doesn't
    // expose them. Avoids deep type expansion through Ref<DocSchema<...>>.
    const outbox: any = exchange.get(outboxDocId, outboxBound)
    const inbox: any = exchange.get(inboxDocId, inboxBound)

    // 8. Register per-line named scope
    const disposeScope = exchange.register({
      name: `line:${topic}:${remotePeerId}`,
      authorize: (
        docId: DocId,
        peer: PeerIdentityDetails,
      ): boolean | undefined => {
        // Outbox: only the local peer can write
        if (docId === outboxDocId) return peer.peerId === exchange.peerId
        // Inbox: only the remote peer can write
        if (docId === inboxDocId) return peer.peerId === remotePeerId
        return undefined
      },
    })

    // 9. Construct and register
    const line = new Line(
      exchange,
      topic,
      remotePeerId,
      outboxDocId,
      inboxDocId,
      outbox,
      inbox,
      outboxBound,
      inboxBound,
      disposeScope,
    )

    registry.set(key, line)
    return line
  }
}

// ---------------------------------------------------------------------------
// openLine — typed entry point (avoids TS2589)
// ---------------------------------------------------------------------------

// Interface call signature defers Plain<S> evaluation to each call site,
// avoiding TS2589 ("excessively deep") that occurs when Plain<S> appears
// in a generic method return type with abstract S extends SchemaNode.
// Same technique used by createDoc in @kyneta/schema/basic.
interface OpenLine {
  <Send extends SchemaNode, Recv extends SchemaNode>(
    exchange: Exchange,
    opts: AsymmetricLineOptions<Send, Recv>,
  ): Line<Plain<Send>, Plain<Recv>>

  <S extends SchemaNode>(
    exchange: Exchange,
    opts: SymmetricLineOptions<S>,
  ): Line<Plain<S>, Plain<S>>
}

/**
 * Open a Line to a remote peer.
 *
 * This is the typed entry point — prefer this over `Line.open()` for
 * full `Plain<S>` type inference without TS2589 depth errors.
 *
 * @example
 * ```ts
 * // Symmetric
 * const line = openLine(exchange, { peer: "bob", schema: SignalSchema })
 *
 * // Asymmetric
 * const line = openLine(exchange, {
 *   peer: "server",
 *   topic: "rpc",
 *   send: RequestSchema,
 *   recv: ResponseSchema,
 * })
 * ```
 */
export const openLine: OpenLine = ((exchange: Exchange, opts: any) =>
  Line.open(exchange, opts)) as any as OpenLine
