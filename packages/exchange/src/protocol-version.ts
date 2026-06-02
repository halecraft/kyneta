// protocol-version — pure compatibility classification for the sync
// wire-contract revision advertised on `establish`.
//
// Why a flat classifier and not a negotiation engine: additive evolution
// rides `WireFeatures` (silent capability negotiation), so protocolVersion
// only has to answer "can these two peers talk at all?" — a rule over a
// single `(major, minor)`, never an intersection. See `ProtocolVersion`
// in `@kyneta/transport` for the full three-axis rationale. Context: jj:yukrpnwm

import type { ProtocolVersion } from "@kyneta/transport"

export type ProtocolSkew = "compatible" | "minor-skew" | "major-mismatch"

// Symmetric: a minor delta classifies the same in either direction — the
// severity reflects the *gap*, not who is ahead.
export function classifyProtocolSkew(
  self: ProtocolVersion,
  peer: ProtocolVersion,
): ProtocolSkew {
  if (self.major !== peer.major) return "major-mismatch"
  if (self.minor !== peer.minor) return "minor-skew"
  return "compatible"
}
