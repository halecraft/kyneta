// observe — the DevTools observation protocol + bus + pure mappers.
//
// Observation is treated as *another interpreter of the effect/message
// stream*: the Synchronizer's session/sync programs already emit inspectable
// data (`SessionEffect`/`SyncEffect`) and consume inspectable inputs, so the
// mapping from those to a renderer-facing `ObsEvent` is a set of total pure
// functions (the functional core below). The Synchronizer (the imperative
// shell) tees the effect/input streams into the bus; the bus fans out to
// sinks fire-and-forget. Context: jj:qpmkoryn.
//
// The protocol owns its OWN string-literal vocabulary — it does not re-export
// internal kyneta types — so it stays stable while internals evolve and can be
// serialized to a remote inspector. `ObsEvent` is EXPERIMENTAL (`v: 1`).

import type { Changeset } from "@kyneta/changefeed"
import type { ChannelMsg, FrameTrace } from "@kyneta/transport"
import type { SessionEffect, SessionInput } from "./session-program.js"
import type { SyncEffect, SyncInput } from "./sync-program.js"
import type { Diagnostic, PeerSyncState } from "./types.js"

// ---------------------------------------------------------------------------
// Protocol version + common envelope
// ---------------------------------------------------------------------------

export const OBS_PROTOCOL_VERSION = 1 as const

/** The observability layers. `wire`/`substrate` arrive in later phases. */
export type ObsLayer =
  | "wire"
  | "protocol"
  | "engine"
  | "directory"
  | "doc"
  | "substrate"
  | "diagnostic"

/** Fields stamped on every event by the bus, regardless of layer. */
export interface ObsEnvelope {
  /** Protocol version — renderers branch on this for forward-compat. */
  readonly v: typeof OBS_PROTOCOL_VERSION
  /** Monotonic per-bus event id. Ordering, independent of wall clock. */
  readonly seq: number
  /** Wall-clock timestamp (ms). Display only, never ordering. */
  readonly t: number
  /** The local peer (Exchange) that emitted this event. */
  readonly peerId: string
  readonly layer: ObsLayer
}

// ---------------------------------------------------------------------------
// Layer bodies
// ---------------------------------------------------------------------------

/**
 * layer "protocol" — a `ChannelMsg` crossing a transport boundary.
 *
 * Addressing granularity differs by seam: lifecycle (`establish`/`depart`)
 * and inbound lifecycle know a `channelId`; sync messages know the remote
 * `peer`. `peer` here is the remote counterparty (distinct from the
 * envelope's `peerId`, which is the local emitter).
 */
export interface MessageBody {
  readonly layer: "protocol"
  readonly kind: "message"
  readonly dir: "out" | "in"
  /** establish | depart | present | interest | offer | dismiss | vacant */
  readonly msgType: string
  /** Remote peer (sync messages). */
  readonly peer?: string
  /** Channel (lifecycle messages). */
  readonly channelId?: number
  /** Doc the message concerns (interest/offer/dismiss/vacant). */
  readonly docId?: string
  /** Serialized version (offer/interest). */
  readonly version?: string
  /** For `present`: the announced docIds. */
  readonly docs?: readonly string[]
}

/** layer "directory" — peer lifecycle (from `emit-peer-events`). */
export interface PeerEventBody {
  readonly layer: "directory"
  readonly kind: "peer"
  readonly change: string
  readonly peer: string
}

/** layer "directory" — document lifecycle (from `emit-doc-events`). */
export interface DocEventBody {
  readonly layer: "directory"
  readonly kind: "doc"
  readonly change: string
  readonly docId: string
}

/**
 * layer "directory" — authoritative per-peer-doc sync status (from the
 * synchronizer's peer-sync-state changes). This is the reconciliation result
 * a consumer must NOT re-derive from protocol events — it is emitted here so a
 * faithful directory/status view folds purely from the event stream.
 */
export interface SyncStateBody {
  readonly layer: "directory"
  readonly kind: "sync-state"
  readonly docId: string
  readonly peer: string
  readonly state: "pending" | "synced" | "vacant"
}

/** A single op inside a changeset, flattened for display. */
export interface ObsOp {
  readonly type: string
  readonly path?: string
}

/**
 * layer "doc" — a `Changeset<Op>` from a document's changefeed.
 *
 * `replay` distinguishes a local `batch()` from state merged in from a peer
 * (sync echo) — the load-bearing provenance field.
 */
export interface ChangesetBody {
  readonly layer: "doc"
  readonly kind: "changeset"
  readonly docId: string
  readonly origin?: string
  readonly replay: boolean
  readonly aborted?: boolean
  readonly ops: readonly ObsOp[]
}

/** layer "engine" — a coalesced TEA state transition (`from !== to`). */
export interface TransitionBody {
  readonly layer: "engine"
  readonly kind: "transition"
  readonly program: "session" | "sync"
  readonly summary: string
}

/**
 * layer "diagnostic" — a silent-failure signal: schema-hash / replica-type /
 * sync-mode mismatch, protocol skew/mismatch, self-connection, duplicate-peer.
 * Aliased to the producer-side `Diagnostic` discriminated union (`src/types.ts`,
 * jj:nztkqwpm) — keyed on `code`, no optionals; each variant carries exactly its
 * fields (`peer`, and per-variant `local`/`remote` + `docId`). Aliasing (not
 * re-declaring) is sound: `PeerId`/`DocId` are plain `string`, so nothing
 * non-serializable leaks into the protocol. The spine guard still holds —
 * `Diagnostic` declares `peer`, never the envelope's `peerId`.
 */
export type DiagnosticBody = {
  readonly layer: "diagnostic"
  readonly kind: "diagnostic"
} & Diagnostic

/**
 * layer "wire" — a frame crossing the wire (from `Pipeline`'s `onFrame`).
 *
 * `frameSeq` is the per-(channel, direction) frame id from the wire header
 * (`FrameTrace.seq`). A sender's send-`frameSeq` equals the receiver's
 * receive-`frameSeq` for the same message *on a single channel* — a
 * per-channel trace-naming aid, NOT a cross-peer correlation key: frame seqs
 * collide across channels and across the two directions of one channel, so a
 * raw-`frameSeq` join over-groups (jj:pusmrzuy Alt #7). The sound cross-peer
 * key is the reserved content-addressed `Frame.hash` (deferred; its future
 * home is `frameHash`). Deliberately NOT named `seq`: in
 * `ObsEvent = ObsEnvelope & WireBody` a body field named `seq` would shadow
 * the envelope's monotonic `seq` (the ordering + `${peerId}:${seq}` identity).
 */
export interface WireBody {
  readonly layer: "wire"
  readonly kind: "frame"
  readonly dir: "send" | "receive"
  readonly frameSeq: number
  readonly frameKind: "complete" | "fragment"
  readonly index?: number
  readonly total?: number
  readonly size: number
}

export type ObsEventBody =
  | MessageBody
  | PeerEventBody
  | DocEventBody
  | SyncStateBody
  | ChangesetBody
  | TransitionBody
  | DiagnosticBody
  | WireBody

/** The thing the bus emits and every renderer consumes. */
export type ObsEvent = ObsEnvelope & ObsEventBody

/** A sink receives every event the bus produces. */
export type ObsSink = (event: ObsEvent) => void

// ---------------------------------------------------------------------------
// Spine-disjointness guard (jj:qpmkoryn correction)
// ---------------------------------------------------------------------------
//
// `ObsEvent = ObsEnvelope & ObsEventBody` is a flat intersection: a body field
// whose name collides with an envelope field is silently unified by name+type,
// and `publish`'s spread then lets one win. That is fine for `layer` (body and
// envelope carry the same value) but catastrophic for a bus-owned spine field
// (it once let `WireBody.seq` shadow the envelope's monotonic `seq`). This
// compile-time assertion forbids any body from declaring `v`/`seq`/`t`/`peerId`
// (`layer` is intentionally excluded — it is delegated to the body). Re-adding
// e.g. `WireBody.seq` makes `SpineCollision` non-`never`, so `AssertTrue<false>`
// fails to compile here.
type SpineField = "v" | "seq" | "t" | "peerId"
type SpineCollision<B> = B extends unknown
  ? Extract<keyof B, SpineField>
  : never
type AssertTrue<T extends true> = T
type _ObsBodySpineDisjoint = AssertTrue<
  [SpineCollision<ObsEventBody>] extends [never] ? true : false
>

// ---------------------------------------------------------------------------
// The bus (imperative shell)
// ---------------------------------------------------------------------------

export interface ObservationBus {
  /** True iff ≥1 sink. Tee call sites gate on this for zero-cost-when-off. */
  readonly enabled: boolean
  /** Stamp the envelope and fan out to sinks. No-op when disabled. */
  publish(body: ObsEventBody): void
  /** Register a sink. Returns an unsubscribe function. */
  subscribe(sink: ObsSink): () => void
}

export function createObservationBus(peerId: string): ObservationBus {
  const sinks = new Set<ObsSink>()
  let seq = 0
  return {
    get enabled(): boolean {
      return sinks.size > 0
    },
    publish(body: ObsEventBody): void {
      if (sinks.size === 0) return
      const event = {
        ...body,
        // The bus owns the spine — stamp it AFTER the body so a body can never
        // shadow the event's identity/ordering (belt-and-suspenders alongside
        // the SpineField guard above). `layer` still comes from the body.
        v: OBS_PROTOCOL_VERSION,
        seq: seq++,
        t: Date.now(),
        peerId,
      } as ObsEvent
      for (const sink of sinks) {
        try {
          sink(event)
        } catch {
          // Swallow — an observer must never break dispatch for others or
          // perturb the convergence cascade. Mirrors @kyneta/machine's
          // notifyTransition.
        }
      }
    },
    subscribe(sink: ObsSink): () => void {
      sinks.add(sink)
      return () => {
        sinks.delete(sink)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Pure mappers (functional core) — total, no Exchange, unit-testable
// ---------------------------------------------------------------------------

/** Extract the renderer-relevant fields from a `ChannelMsg`. */
function msgFields(
  msg: ChannelMsg,
): Pick<MessageBody, "msgType" | "docId" | "version" | "docs"> {
  const m = msg as Record<string, unknown>
  return {
    msgType: msg.type,
    docId: typeof m.docId === "string" ? m.docId : undefined,
    version: typeof m.version === "string" ? m.version : undefined,
    docs: Array.isArray(m.docs)
      ? (m.docs as Array<{ docId: string }>).map(d => d.docId)
      : undefined,
  }
}

/** Map a `SessionEffect` to zero or more observation events. */
export function observeSessionEffect(fx: SessionEffect): ObsEventBody[] {
  switch (fx.type) {
    case "send":
      return [
        {
          layer: "protocol",
          kind: "message",
          dir: "out",
          channelId: fx.to,
          ...msgFields(fx.message),
        },
      ]
    case "emit-peer-events":
      return fx.events.map(e => ({
        layer: "directory" as const,
        kind: "peer" as const,
        change: e.type,
        peer: e.peer.peerId,
      }))
    case "diagnostic": {
      // Spread the structured `Diagnostic` straight through, dropping the
      // effect's `type` tag. Context: jj:nztkqwpm.
      const { type: _type, ...body } = fx
      return [{ layer: "diagnostic", kind: "diagnostic", ...body }]
    }
    default:
      return []
  }
}

/** Map a `SyncEffect` to zero or more observation events. */
export function observeSyncEffect(fx: SyncEffect): ObsEventBody[] {
  switch (fx.type) {
    case "send-to-peer":
      return [
        {
          layer: "protocol",
          kind: "message",
          dir: "out",
          peer: fx.to,
          ...msgFields(fx.message),
        },
      ]
    case "send-to-peers":
      return fx.to.map(peer => ({
        layer: "protocol" as const,
        kind: "message" as const,
        dir: "out" as const,
        peer,
        ...msgFields(fx.message),
      }))
    case "send-offer":
      return [
        {
          layer: "protocol",
          kind: "message",
          dir: "out",
          peer: fx.to,
          msgType: "offer",
          docId: fx.docId,
          version: fx.sinceVersion,
        },
      ]
    case "send-offers":
      return fx.to.map(peer => ({
        layer: "protocol" as const,
        kind: "message" as const,
        dir: "out" as const,
        peer,
        msgType: "offer",
        docId: fx.docId,
        version: fx.sinceVersion,
      }))
    case "emit-doc-events":
      return fx.events.map(e => ({
        layer: "directory" as const,
        kind: "doc" as const,
        change: e.type,
        docId: e.docId,
      }))
    case "diagnostic": {
      // The former `warning` effect, now the unified structured `Diagnostic`.
      // Context: jj:nztkqwpm.
      const { type: _type, ...body } = fx
      return [{ layer: "diagnostic", kind: "diagnostic", ...body }]
    }
    default:
      return []
  }
}

/** Map an inbound program input to zero or more observation events. */
export function observeInput(input: SessionInput | SyncInput): ObsEventBody[] {
  switch (input.type) {
    case "sess/message-received":
      return [
        {
          layer: "protocol",
          kind: "message",
          dir: "in",
          channelId: input.fromChannelId,
          ...msgFields(input.message),
        },
      ]
    case "sync/message-received":
      return [
        {
          layer: "protocol",
          kind: "message",
          dir: "in",
          peer: input.from,
          ...msgFields(input.message),
        },
      ]
    default:
      return []
  }
}

/**
 * Map a doc's per-peer sync states to `sync-state` events (one per peer).
 * The authoritative reconciliation result — emitted so consumers fold status
 * from the stream rather than re-deriving it.
 */
export function observePeerSyncState(
  docId: string,
  peerStates: readonly PeerSyncState[],
): ObsEventBody[] {
  return peerStates.map(ps => ({
    layer: "directory" as const,
    kind: "sync-state" as const,
    docId,
    peer: ps.peer.peerId,
    state: ps.state,
  }))
}

/** Map a wire `FrameTrace` to a `wire` event. */
export function frameTraceToBody(ev: FrameTrace): WireBody {
  return {
    layer: "wire",
    kind: "frame",
    dir: ev.dir,
    frameSeq: ev.seq,
    frameKind: ev.kind,
    index: ev.index,
    total: ev.total,
    size: ev.size,
  }
}

/**
 * Summarize a document `Changeset` into a `doc` event. Uses `Path.format()`,
 * the canonical stringifier. The descendant op shape is
 * `{ path: Path, change: ChangeBase }`.
 */
export function summarizeChangeset(
  docId: string,
  cs: Changeset<unknown>,
): ChangesetBody {
  const ops: ObsOp[] = []
  for (const op of cs.changes as readonly unknown[]) {
    const o = op as {
      path?: { format?: () => string }
      change?: { type?: string }
      type?: string
    }
    ops.push({
      type: o.change?.type ?? o.type ?? "?",
      path: typeof o.path?.format === "function" ? o.path.format() : undefined,
    })
  }
  return {
    layer: "doc",
    kind: "changeset",
    docId,
    origin: cs.origin,
    replay: Boolean(cs.replay),
    aborted: cs.aborted,
    ops,
  }
}
