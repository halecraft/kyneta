// wire-fixtures — construct WireMessage literals for wire-internal tests.
//
// These helpers replace the previous pattern of importing
// applyOutboundAliasing + emptyAliasState from alias-table.ts (which
// has moved to @kyneta/transport). Wire tests that need ChannelMsg →
// WireMessage conversion use these direct constructors instead.

import type { SyncMode } from "@kyneta/schema"
import {
  MessageType,
  StringToPayloadEncoding,
  StringToPayloadKind,
  syncModeToWire,
  type WireDismissMsg,
  type WireEstablishMsg,
  type WireInterestMsg,
  type WireMessage,
  type WireOfferMsg,
  type WirePresentMsg,
  type WireVacantMsg,
} from "../../wire-types.js"

// ---------------------------------------------------------------------------
// Establish
// ---------------------------------------------------------------------------

export function establishWire(opts: {
  peerId: string
  type: "user" | "bot" | "service"
  name?: string
  features?: { alias?: boolean; streamed?: boolean; datagram?: boolean }
  protocolVersion?: [number, number]
}): WireEstablishMsg {
  const wire: WireEstablishMsg = {
    t: MessageType.Establish,
    id: opts.peerId,
    y: opts.type,
  }
  if (opts.name !== undefined) wire.n = opts.name
  if (opts.features !== undefined) {
    wire.f = {}
    if (opts.features.alias !== undefined) wire.f.a = opts.features.alias
    if (opts.features.streamed !== undefined) wire.f.s = opts.features.streamed
    if (opts.features.datagram !== undefined) wire.f.d = opts.features.datagram
  }
  if (opts.protocolVersion !== undefined) wire.pv = opts.protocolVersion
  return wire
}

// ---------------------------------------------------------------------------
// Depart
// ---------------------------------------------------------------------------

export function departWire(): WireMessage {
  return { t: MessageType.Depart }
}

// ---------------------------------------------------------------------------
// Present
// ---------------------------------------------------------------------------

export function presentWire(
  docs: Array<{
    docId: string
    schemaHash: string
    replicaType: readonly [string, number, number]
    syncMode: SyncMode
    supportedHashes?: readonly string[]
  }>,
): WirePresentMsg {
  return {
    t: MessageType.Present,
    docs: docs.map(d => {
      const entry: WirePresentMsg["docs"][number] = {
        d: d.docId,
        rt: [...d.replicaType] as [string, number, number],
        ms: syncModeToWire(d.syncMode),
        sh: d.schemaHash,
      }
      if (d.supportedHashes && d.supportedHashes.length > 1) {
        entry.shs = [...d.supportedHashes]
      }
      return entry
    }),
  }
}

// ---------------------------------------------------------------------------
// Interest
// ---------------------------------------------------------------------------

export function interestWire(opts: {
  docId: string
  version?: string
  reciprocate?: boolean
}): WireInterestMsg {
  const wire: WireInterestMsg = {
    t: MessageType.Interest,
    doc: opts.docId,
  }
  if (opts.version !== undefined) wire.v = opts.version
  if (opts.reciprocate !== undefined) wire.r = opts.reciprocate
  return wire
}

// ---------------------------------------------------------------------------
// Offer
// ---------------------------------------------------------------------------

export function offerWire(opts: {
  docId: string
  kind: "entirety" | "since"
  encoding: "json" | "binary"
  data: string | Uint8Array
  version: string
  reciprocate?: boolean
  epoch?: string
}): WireOfferMsg {
  const pk = StringToPayloadKind[opts.kind]
  if (pk === undefined) throw new Error(`Unknown payload kind: ${opts.kind}`)
  const pe = StringToPayloadEncoding[opts.encoding]
  if (pe === undefined)
    throw new Error(`Unknown payload encoding: ${opts.encoding}`)
  const wire: WireOfferMsg = {
    t: MessageType.Offer,
    doc: opts.docId,
    pk,
    pe,
    d: opts.data,
    v: opts.version,
  }
  if (opts.reciprocate !== undefined) wire.r = opts.reciprocate
  if (opts.epoch !== undefined) wire.ep = opts.epoch
  return wire
}

// ---------------------------------------------------------------------------
// Dismiss
// ---------------------------------------------------------------------------

export function dismissWire(docId: string): WireDismissMsg {
  return { t: MessageType.Dismiss, doc: docId }
}

// ---------------------------------------------------------------------------
// Vacant
// ---------------------------------------------------------------------------

export function vacantWire(docId: string): WireVacantMsg {
  return { t: MessageType.Vacant, doc: docId }
}
