// wire-error — discriminated union of all wire-pipeline errors.
//
// Lives in @kyneta/wire so Pipeline (in @kyneta/transport) can
// reference a single error type for its onError callback without
// importing from multiple wire modules.

import type { AliasResolutionError } from "./alias-error.js"
import type { FrameDecodeErrorCode } from "./frame.js"
import type { ReassembleError } from "./reassembler-generic.js"
import type { TextFrameDecodeErrorCode } from "./text-frame.js"
import type { WireValidationError } from "./validate-wire-message.js"

export type WireError =
  | {
      readonly code: "alias-resolution-failed"
      readonly detail: AliasResolutionError
    }
  | { readonly code: "decode-failed"; readonly detail: unknown }
  | {
      readonly code: "frame-decode-failed"
      readonly detail: FrameDecodeErrorCode | TextFrameDecodeErrorCode
    }
  | { readonly code: "reassembly-failed"; readonly detail: ReassembleError }
  | {
      readonly code: "reassembly-timeout"
      readonly detail: {
        readonly frameId: number
        readonly partialCount: number
      }
    }
  | {
      readonly code: "reassembly-evicted"
      readonly detail: { readonly frameId: number }
    }
  | {
      readonly code: "frame-too-large"
      readonly detail: { readonly size: number; readonly limit: number }
    }
  | {
      readonly code: "empty-payload"
      readonly detail: { readonly totalSize: 0 }
    }
  | {
      readonly code: "too-many-fragments"
      readonly detail: { readonly total: number; readonly max: number }
    }
  | {
      readonly code: "invalid-wire-message"
      readonly detail: WireValidationError
    }
