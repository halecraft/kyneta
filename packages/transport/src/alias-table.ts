// alias-table — pure ChannelMsg ⇄ WireMessage transformer with alias state.
//
// Two pure functions form the FC/IS contract:
//   applyOutboundAliasing(state, msg) → { state, result: Result<WireMessage> }
//   applyInboundAliasing(state, wire) → { state, result: Result<ChannelMsg> }
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

import {
  type Alias,
  type AliasResolutionError,
  MessageType,
  PayloadEncodingToString,
  PayloadKindToString,
  StringToPayloadEncoding,
  StringToPayloadKind,
  SyncModeWireToMode,
  syncModeToWire,
  validateDocId,
  validateSchemaHash,
  type WireDismissMsg,
  type WireEstablishMsg,
  type WireInterestMsg,
  type WireMessage,
  type WireOfferMsg,
  type WirePresentMsg,
  type WireVacantMsg,
} from "@kyneta/wire"
import type {
  ChannelMsg,
  EstablishMsg,
  InterestMsg,
  OfferMsg,
  PresentMsg,
  WireFeatures,
} from "./messages.js"
import { PROTOCOL_VERSION } from "./types.js"

export type { Alias } from "@kyneta/wire"

import { err, ok, type Result } from "@kyneta/wire"

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
): { state: AliasState; result: Result<WireMessage, AliasResolutionError> } {
  switch (msg.type) {
    case "establish": {
      const newState: AliasState = {
        ...state,
        selfFeatures: msg.features,
        mutualAlias: deriveMutualAlias(msg.features, state.peerFeatures),
      }
      const wire: WireEstablishMsg = {
        t: MessageType.Establish,
        id: msg.identity.peerId,
        n: msg.identity.name,
        y: msg.identity.type,
      }
      if (msg.features !== undefined) {
        wire.f = {}
        if (msg.features.alias !== undefined) wire.f.a = msg.features.alias
        if (msg.features.streamed !== undefined)
          wire.f.s = msg.features.streamed
        if (msg.features.datagram !== undefined)
          wire.f.d = msg.features.datagram
      }
      // Omit pv at the default so a (1,0) peer's establish stays
      // byte-identical to a pre-protocolVersion peer's — the same
      // omit-default convention as `shs` and `WireFeatures`.
      const pv = msg.protocolVersion
      if (
        pv.major !== PROTOCOL_VERSION.major ||
        pv.minor !== PROTOCOL_VERSION.minor
      ) {
        wire.pv = [pv.major, pv.minor]
      }
      return { state: newState, result: ok(wire) }
    }

    case "depart":
      return {
        state,
        result: ok({ t: MessageType.Depart }),
      }

    case "present": {
      let s = state
      const docs: WirePresentMsg["docs"] = []
      for (const d of msg.docs) {
        // Always assign / look up a docId alias and emit it as `a`
        // (announcement) regardless of mutualAlias.
        const docAssign = getOrAssignOutboundDocAlias(s, d.docId)
        s = docAssign.state

        const ms = syncModeToWire(d.syncMode)
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
      return { state: s, result: ok({ t: MessageType.Present, docs }) }
    }

    case "interest": {
      const wire: WireInterestMsg = { t: MessageType.Interest }
      const aliasInfo = state.outboundAliasByDoc.get(msg.docId)
      if (aliasInfo !== undefined && state.mutualAlias) {
        wire.dx = aliasInfo
      } else {
        wire.doc = msg.docId
      }
      if (msg.version !== undefined) wire.v = msg.version
      if (msg.reciprocate !== undefined) wire.r = msg.reciprocate
      return { state, result: ok(wire) }
    }

    case "offer": {
      const pk = StringToPayloadKind[msg.payload.kind]
      if (pk === undefined) {
        return {
          state,
          result: err({
            code: "unknown-payload-kind",
            value: msg.payload.kind,
          }),
        }
      }
      const pe = StringToPayloadEncoding[msg.payload.encoding]
      if (pe === undefined) {
        return {
          state,
          result: err({
            code: "unknown-payload-encoding",
            value: msg.payload.encoding,
          }),
        }
      }
      const wire: WireOfferMsg = {
        t: MessageType.Offer,
        pk,
        pe,
        d: msg.payload.data,
        v: msg.version,
      }
      const aliasInfo = state.outboundAliasByDoc.get(msg.docId)
      if (aliasInfo !== undefined && state.mutualAlias) {
        wire.dx = aliasInfo
      } else {
        wire.doc = msg.docId
      }
      if (msg.reciprocate !== undefined) wire.r = msg.reciprocate
      return { state, result: ok(wire) }
    }

    case "dismiss": {
      const wire: WireDismissMsg = { t: MessageType.Dismiss }
      const aliasInfo = state.outboundAliasByDoc.get(msg.docId)
      if (aliasInfo !== undefined && state.mutualAlias) {
        wire.dx = aliasInfo
      } else {
        wire.doc = msg.docId
      }
      return { state, result: ok(wire) }
    }

    case "vacant": {
      const wire: WireVacantMsg = { t: MessageType.Vacant }
      const aliasInfo = state.outboundAliasByDoc.get(msg.docId)
      if (aliasInfo !== undefined && state.mutualAlias) {
        wire.dx = aliasInfo
      } else {
        wire.doc = msg.docId
      }
      return { state, result: ok(wire) }
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
 *
 * Also validates docId and schemaHash byte-length caps on the inbound
 * side (trust boundary). Outbound data is locally generated and trusted.
 */
export function applyInboundAliasing(
  state: AliasState,
  wire: WireMessage,
): { state: AliasState; result: Result<ChannelMsg, AliasResolutionError> } {
  switch (wire.t) {
    case MessageType.Establish: {
      const features: WireFeatures | undefined = wire.f
        ? {
            ...(wire.f.a !== undefined ? { alias: wire.f.a } : {}),
            ...(wire.f.s !== undefined ? { streamed: wire.f.s } : {}),
            ...(wire.f.d !== undefined ? { datagram: wire.f.d } : {}),
          }
        : undefined
      const newState: AliasState = {
        ...state,
        peerFeatures: features,
        mutualAlias: deriveMutualAlias(state.selfFeatures, features),
      }
      const msg: EstablishMsg = {
        type: "establish",
        identity: { peerId: wire.id, name: wire.n, type: wire.y },
        // Default an absent pv to PROTOCOL_VERSION at the wire boundary, so
        // the parsed domain message always carries a concrete version
        // (absent and explicit-(1,0) are indistinguishable downstream).
        protocolVersion:
          wire.pv !== undefined
            ? { major: wire.pv[0], minor: wire.pv[1] }
            : PROTOCOL_VERSION,
      }
      if (features !== undefined) msg.features = features
      return { state: newState, result: ok(msg) }
    }

    case MessageType.Depart:
      return { state, result: ok({ type: "depart" }) }

    case MessageType.Present: {
      let s = state
      const docs: PresentMsg["docs"] = []
      for (const d of wire.docs) {
        const syncMode = SyncModeWireToMode[d.ms]
        if (!syncMode) {
          return {
            state: s,
            result: err({ code: "unknown-sync-mode", value: d.ms }),
          }
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
              result: err({ code: "unknown-schema-alias", alias: d.shx }),
            }
          }
          schemaHash = resolved
        } else {
          return {
            state: s,
            result: err({
              code: "missing-schema-hash",
              reason: "Present doc entry has neither sh nor shx",
            }),
          }
        }

        // Validate schema hash byte length after resolution.
        const shErr = validateSchemaHash(schemaHash)
        if (shErr) return { state: s, result: err(shErr) }

        docs.push({
          docId: d.d,
          replicaType: d.rt as readonly [string, number, number],
          syncMode,
          schemaHash,
          ...(d.shs ? { supportedHashes: d.shs } : undefined),
        })
      }
      return { state: s, result: ok({ type: "present", docs }) }
    }

    case MessageType.Interest: {
      const docResult = resolveDocId(s_get_inbound(state), wire.doc, wire.dx)
      if ("error" in docResult) return { state, result: err(docResult.error) }
      const docErr = validateDocId(docResult.docId)
      if (docErr) return { state, result: err(docErr) }
      const msg: InterestMsg = { type: "interest", docId: docResult.docId }
      if (wire.v !== undefined) msg.version = wire.v
      if (wire.r !== undefined) msg.reciprocate = wire.r
      return { state, result: ok(msg) }
    }

    case MessageType.Offer: {
      const docResult = resolveDocId(s_get_inbound(state), wire.doc, wire.dx)
      if ("error" in docResult) return { state, result: err(docResult.error) }
      const docErr = validateDocId(docResult.docId)
      if (docErr) return { state, result: err(docErr) }
      const kind =
        PayloadKindToString[wire.pk as keyof typeof PayloadKindToString]
      const encoding =
        PayloadEncodingToString[wire.pe as keyof typeof PayloadEncodingToString]
      if (!kind) {
        return {
          state,
          result: err({ code: "unknown-payload-kind", value: wire.pk }),
        }
      }
      if (!encoding) {
        return {
          state,
          result: err({ code: "unknown-payload-encoding", value: wire.pe }),
        }
      }
      const msg: OfferMsg = {
        type: "offer",
        docId: docResult.docId,
        payload: { kind, encoding, data: wire.d },
        version: wire.v,
      }
      if (wire.r !== undefined) msg.reciprocate = wire.r
      return { state, result: ok(msg) }
    }

    case MessageType.Dismiss: {
      const docResult = resolveDocId(s_get_inbound(state), wire.doc, wire.dx)
      if ("error" in docResult) return { state, result: err(docResult.error) }
      const docErr = validateDocId(docResult.docId)
      if (docErr) return { state, result: err(docErr) }
      return { state, result: ok({ type: "dismiss", docId: docResult.docId }) }
    }

    case MessageType.Vacant: {
      const docResult = resolveDocId(s_get_inbound(state), wire.doc, wire.dx)
      if ("error" in docResult) return { state, result: err(docResult.error) }
      const docErr = validateDocId(docResult.docId)
      if (docErr) return { state, result: err(docErr) }
      return { state, result: ok({ type: "vacant", docId: docResult.docId }) }
    }

    default:
      return {
        state,
        result: err({
          code: "unknown-message-type",
          value: (wire as WireMessage).t,
        }),
      }
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
