// alias-table — pure ChannelMsg ⇄ WireMessage transformer with alias state.
//
// Two pure functions form the FC/IS contract:
//   applyOutboundAliasing(state, msg) → { state, wire }
//   applyInboundAliasing(state, wire) → { state, msg | error }
//
// State carries:
//   - bidirectional alias maps (outbound assignments + inbound records) for
//     both DocIds and schema hashes
//   - monotonic counters for next outbound assignment
//   - features advertised by self / peer (snapshotted from establish)
//   - mutualAlias: derived per-feature AND of self & peer features
//
// On `establish` messages, the transformer snapshots `features` into state
// and re-derives `mutualAlias`. The shell does not need to wire features in
// separately — every channel observes its own establish messages flowing
// through the transformer at the codec seam.
//
// Announce vs use:
//   - Alias announcements (`a` on present-doc, `sa` on present-schema) are
//     emitted unconditionally. CBOR map decoders ignore unknown fields, so
//     old peers see harmless extra bytes; new peers can pick them up.
//   - Alias uses (`dx`, or `shx` with `sh` absent) are gated on
//     `state.mutualAlias === true` — only emitted once both sides have
//     advertised support.

import type {
  ChannelMsg,
  DismissMsg,
  EstablishMsg,
  InterestMsg,
  OfferMsg,
  PresentMsg,
  WireFeatures,
} from "@kyneta/transport"
import {
  MessageType,
  PayloadEncodingToString,
  PayloadKindToString,
  StringToPayloadEncoding,
  StringToPayloadKind,
  SyncProtocolWireToProtocol,
  syncProtocolToWire,
  type WireDismissMsg,
  type WireEstablishMsg,
  type WireInterestMsg,
  type WireMessage,
  type WireOfferMsg,
  type WirePresentMsg,
} from "./wire-types.js"

export type Alias = number

export type AliasState = {
  /** Outbound: docId → alias I've assigned. */
  outboundAliasByDoc: ReadonlyMap<string, Alias>
  /** Outbound: schema hash → alias I've assigned. */
  outboundAliasBySchemaHash: ReadonlyMap<string, Alias>
  /** Inbound: alias → full docId, recorded when peer announces. */
  inboundDocByAlias: ReadonlyMap<Alias, string>
  /** Inbound: alias → full schema hash, recorded when peer announces. */
  inboundSchemaHashByAlias: ReadonlyMap<Alias, string>
  /** Next outbound docId alias to assign. */
  nextOutDocAlias: number
  /** Next outbound schema hash alias to assign. */
  nextOutSchemaAlias: number
  /** Features this peer advertises in outbound establish. */
  selfFeatures?: WireFeatures
  /** Features the remote peer advertised in inbound establish. */
  peerFeatures?: WireFeatures
  /** Derived: per-feature AND of self & peer; false until both establish. */
  mutualAlias: boolean
}

export type AliasResolutionError =
  | { code: "unknown-doc-alias"; alias: Alias }
  | { code: "unknown-schema-alias"; alias: Alias }
  | { code: "missing-doc-id"; reason: string }
  | { code: "missing-schema-hash"; reason: string }

export function emptyAliasState(): AliasState {
  return {
    outboundAliasByDoc: new Map(),
    outboundAliasBySchemaHash: new Map(),
    inboundDocByAlias: new Map(),
    inboundSchemaHashByAlias: new Map(),
    nextOutDocAlias: 0,
    nextOutSchemaAlias: 0,
    mutualAlias: false,
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function deriveMutualAlias(
  self: WireFeatures | undefined,
  peer: WireFeatures | undefined,
): boolean {
  return self?.alias === true && peer?.alias === true
}

/**
 * Assign (or look up) the outbound alias for a docId. Idempotent: the same
 * docId from the same state always yields the same alias.
 */
function getOrAssignOutboundDocAlias(
  state: AliasState,
  docId: string,
): { state: AliasState; alias: Alias; isNew: boolean } {
  const existing = state.outboundAliasByDoc.get(docId)
  if (existing !== undefined) {
    return { state, alias: existing, isNew: false }
  }
  const alias = state.nextOutDocAlias
  const map = new Map(state.outboundAliasByDoc)
  map.set(docId, alias)
  return {
    state: {
      ...state,
      outboundAliasByDoc: map,
      nextOutDocAlias: alias + 1,
    },
    alias,
    isNew: true,
  }
}

function getOrAssignOutboundSchemaAlias(
  state: AliasState,
  schemaHash: string,
): { state: AliasState; alias: Alias; isNew: boolean } {
  const existing = state.outboundAliasBySchemaHash.get(schemaHash)
  if (existing !== undefined) {
    return { state, alias: existing, isNew: false }
  }
  const alias = state.nextOutSchemaAlias
  const map = new Map(state.outboundAliasBySchemaHash)
  map.set(schemaHash, alias)
  return {
    state: {
      ...state,
      outboundAliasBySchemaHash: map,
      nextOutSchemaAlias: alias + 1,
    },
    alias,
    isNew: true,
  }
}

function recordInboundDocAlias(
  state: AliasState,
  alias: Alias,
  docId: string,
): AliasState {
  // Idempotent: re-recording the same alias→docId is a no-op.
  if (state.inboundDocByAlias.get(alias) === docId) return state
  const map = new Map(state.inboundDocByAlias)
  map.set(alias, docId)
  return { ...state, inboundDocByAlias: map }
}

function recordInboundSchemaAlias(
  state: AliasState,
  alias: Alias,
  schemaHash: string,
): AliasState {
  if (state.inboundSchemaHashByAlias.get(alias) === schemaHash) return state
  const map = new Map(state.inboundSchemaHashByAlias)
  map.set(alias, schemaHash)
  return { ...state, inboundSchemaHashByAlias: map }
}

// ---------------------------------------------------------------------------
// Outbound transformer
// ---------------------------------------------------------------------------

/**
 * Pure transformer: rewrite an outbound `ChannelMsg` to its `WireMessage`
 * form, inserting alias fields based on the current state.
 *
 * Behaviors per message type:
 *   - establish: snapshots `msg.features` into `state.selfFeatures`,
 *     re-derives `mutualAlias`. Wire form mirrors the channel form.
 *   - depart: pass-through.
 *   - present: announces aliases (`a`, `sa`) for any doc/schema not yet
 *     assigned. Always sets `d` and `sh` (full identifiers) for
 *     forward-compat. The first reference to a schema also assigns `sa`.
 *   - interest/offer/dismiss: if mutual alias is on AND the doc has an
 *     alias, emits `dx` with `doc` absent. Otherwise emits `doc`.
 */
export function applyOutboundAliasing(
  state: AliasState,
  msg: ChannelMsg,
): { state: AliasState; wire: WireMessage } {
  switch (msg.type) {
    case "establish": {
      const m = msg as EstablishMsg
      const newState: AliasState = {
        ...state,
        selfFeatures: m.features,
        mutualAlias: deriveMutualAlias(m.features, state.peerFeatures),
      }
      const wire: WireEstablishMsg = {
        t: MessageType.Establish,
        id: m.identity.peerId,
        n: m.identity.name,
        y: m.identity.type,
      }
      if (m.features !== undefined) {
        wire.f = {}
        if (m.features.alias !== undefined) wire.f.a = m.features.alias
        if (m.features.streamed !== undefined) wire.f.s = m.features.streamed
        if (m.features.datagram !== undefined) wire.f.d = m.features.datagram
      }
      return { state: newState, wire }
    }

    case "depart":
      return {
        state,
        wire: { t: MessageType.Depart },
      }

    case "present": {
      const m = msg as PresentMsg
      let s = state
      const docs: WirePresentMsg["docs"] = []
      for (const d of m.docs) {
        // Always assign / look up a docId alias and emit it as `a`
        // (announcement) regardless of mutualAlias.
        const docAssign = getOrAssignOutboundDocAlias(s, d.docId)
        s = docAssign.state

        const ms = syncProtocolToWire(d.syncProtocol)
        const entry: WirePresentMsg["docs"][number] = {
          d: d.docId,
          a: docAssign.alias,
          rt: [...d.replicaType] as [string, number, number],
          ms,
        }

        // Schema hash: first reference assigns `sa` and keeps `sh`.
        // Subsequent references emit `shx` only IF mutualAlias is on.
        const schemaAssign = getOrAssignOutboundSchemaAlias(s, d.schemaHash)
        s = schemaAssign.state
        if (schemaAssign.isNew || !s.mutualAlias) {
          entry.sh = d.schemaHash
          if (schemaAssign.isNew) entry.sa = schemaAssign.alias
        } else {
          entry.shx = schemaAssign.alias
        }

        if (d.supportedHashes && d.supportedHashes.length > 1) {
          entry.shs = [...d.supportedHashes]
        }
        docs.push(entry)
      }
      return { state: s, wire: { t: MessageType.Present, docs } }
    }

    case "interest": {
      const m = msg as InterestMsg
      const wire: WireInterestMsg = { t: MessageType.Interest }
      const aliasInfo = state.outboundAliasByDoc.get(m.docId)
      if (aliasInfo !== undefined && state.mutualAlias) {
        wire.dx = aliasInfo
      } else {
        wire.doc = m.docId
      }
      if (m.version !== undefined) wire.v = m.version
      if (m.reciprocate !== undefined) wire.r = m.reciprocate
      return { state, wire }
    }

    case "offer": {
      const m = msg as OfferMsg
      const pk = StringToPayloadKind[m.payload.kind]
      if (pk === undefined) {
        throw new Error(`Unknown payload kind: ${m.payload.kind}`)
      }
      const pe = StringToPayloadEncoding[m.payload.encoding]
      if (pe === undefined) {
        throw new Error(`Unknown payload encoding: ${m.payload.encoding}`)
      }
      const wire: WireOfferMsg = {
        t: MessageType.Offer,
        pk,
        pe,
        d: m.payload.data,
        v: m.version,
      }
      const aliasInfo = state.outboundAliasByDoc.get(m.docId)
      if (aliasInfo !== undefined && state.mutualAlias) {
        wire.dx = aliasInfo
      } else {
        wire.doc = m.docId
      }
      if (m.reciprocate !== undefined) wire.r = m.reciprocate
      return { state, wire }
    }

    case "dismiss": {
      const m = msg as DismissMsg
      const wire: WireDismissMsg = { t: MessageType.Dismiss }
      const aliasInfo = state.outboundAliasByDoc.get(m.docId)
      if (aliasInfo !== undefined && state.mutualAlias) {
        wire.dx = aliasInfo
      } else {
        wire.doc = m.docId
      }
      return { state, wire }
    }
  }
}

// ---------------------------------------------------------------------------
// Inbound transformer
// ---------------------------------------------------------------------------

/**
 * Pure transformer: resolve a `WireMessage` to its `ChannelMsg` form,
 * recording any introduced aliases and substituting referenced ones.
 *
 * Returns `error` (without `msg`) when an alias is referenced before it
 * has been introduced — a protocol violation. The caller should log and
 * drop; channel state remains valid.
 */
export function applyInboundAliasing(
  state: AliasState,
  wire: WireMessage,
): { state: AliasState; msg?: ChannelMsg; error?: AliasResolutionError } {
  switch (wire.t) {
    case MessageType.Establish: {
      const w = wire as WireEstablishMsg
      const features: WireFeatures | undefined = w.f
        ? {
            ...(w.f.a !== undefined ? { alias: w.f.a } : {}),
            ...(w.f.s !== undefined ? { streamed: w.f.s } : {}),
            ...(w.f.d !== undefined ? { datagram: w.f.d } : {}),
          }
        : undefined
      const newState: AliasState = {
        ...state,
        peerFeatures: features,
        mutualAlias: deriveMutualAlias(state.selfFeatures, features),
      }
      const msg: EstablishMsg = {
        type: "establish",
        identity: { peerId: w.id, name: w.n, type: w.y },
      }
      if (features !== undefined) msg.features = features
      return { state: newState, msg }
    }

    case MessageType.Depart:
      return { state, msg: { type: "depart" } }

    case MessageType.Present: {
      const w = wire as WirePresentMsg
      let s = state
      const docs: PresentMsg["docs"] = []
      for (const d of w.docs) {
        const syncProtocol = SyncProtocolWireToProtocol[d.ms]
        if (!syncProtocol) {
          throw new Error(`Unknown wire sync protocol: ${d.ms}`)
        }

        // Record peer's docId alias announcement (always present in v1).
        if (d.a !== undefined) {
          s = recordInboundDocAlias(s, d.a, d.d)
        }

        // Schema hash: resolve sh / shx / sa (assignment).
        let schemaHash: string
        if (d.sh !== undefined) {
          schemaHash = d.sh
          if (d.sa !== undefined) {
            s = recordInboundSchemaAlias(s, d.sa, d.sh)
          }
        } else if (d.shx !== undefined) {
          const resolved = s.inboundSchemaHashByAlias.get(d.shx)
          if (resolved === undefined) {
            return {
              state: s,
              error: { code: "unknown-schema-alias", alias: d.shx },
            }
          }
          schemaHash = resolved
        } else {
          return {
            state: s,
            error: {
              code: "missing-schema-hash",
              reason: "Present doc entry has neither sh nor shx",
            },
          }
        }

        docs.push({
          docId: d.d,
          replicaType: d.rt as readonly [string, number, number],
          syncProtocol,
          schemaHash,
          ...(d.shs ? { supportedHashes: d.shs } : undefined),
        })
      }
      return { state: s, msg: { type: "present", docs } }
    }

    case MessageType.Interest: {
      const w = wire as WireInterestMsg
      const result = resolveDocId(s_get_inbound(state), w.doc, w.dx)
      if ("error" in result) return { state, error: result.error }
      const msg: InterestMsg = { type: "interest", docId: result.docId }
      if (w.v !== undefined) msg.version = w.v
      if (w.r !== undefined) msg.reciprocate = w.r
      return { state, msg }
    }

    case MessageType.Offer: {
      const w = wire as WireOfferMsg
      const result = resolveDocId(s_get_inbound(state), w.doc, w.dx)
      if ("error" in result) return { state, error: result.error }
      const kind = PayloadKindToString[w.pk as keyof typeof PayloadKindToString]
      const encoding =
        PayloadEncodingToString[w.pe as keyof typeof PayloadEncodingToString]
      if (!kind) {
        throw new Error(`Unknown wire payload kind: ${w.pk}`)
      }
      if (!encoding) {
        throw new Error(`Unknown wire payload encoding: ${w.pe}`)
      }
      const msg: OfferMsg = {
        type: "offer",
        docId: result.docId,
        payload: { kind, encoding, data: w.d },
        version: w.v,
      }
      if (w.r !== undefined) msg.reciprocate = w.r
      return { state, msg }
    }

    case MessageType.Dismiss: {
      const w = wire as WireDismissMsg
      const result = resolveDocId(s_get_inbound(state), w.doc, w.dx)
      if ("error" in result) return { state, error: result.error }
      return { state, msg: { type: "dismiss", docId: result.docId } }
    }

    default:
      throw new Error(`Unknown wire message type: ${(wire as WireMessage).t}`)
  }
}

/** Read-only view of the inbound docId map for resolution. */
function s_get_inbound(state: AliasState): ReadonlyMap<Alias, string> {
  return state.inboundDocByAlias
}

function resolveDocId(
  inbound: ReadonlyMap<Alias, string>,
  doc: string | undefined,
  dx: number | undefined,
): { docId: string } | { error: AliasResolutionError } {
  if (doc !== undefined && dx !== undefined) {
    return {
      error: {
        code: "missing-doc-id",
        reason: "wire form must not carry both doc and dx",
      },
    }
  }
  if (doc !== undefined) return { docId: doc }
  if (dx !== undefined) {
    const resolved = inbound.get(dx)
    if (resolved === undefined) {
      return { error: { code: "unknown-doc-alias", alias: dx } }
    }
    return { docId: resolved }
  }
  return {
    error: {
      code: "missing-doc-id",
      reason: "wire form has neither doc nor dx",
    },
  }
}
