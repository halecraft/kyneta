// validate-wire-message — runtime validation for decoded WireMessage objects.
//
// Accepts `unknown` input and checks structural conformance to the
// WireMessage union. Unknown fields pass through silently for
// wire-format forward compatibility.

import { type Err, err, ok, type Result } from "./result.js"
import {
  MessageType,
  type MessageTypeValue,
  PayloadEncoding,
  PayloadKind,
  SyncProtocolWire,
  type WireMessage,
} from "./wire-types.js"

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type WireValidationError = {
  readonly reason: string
  readonly path?: readonly (string | number)[]
}

export class WireValidationFailure extends Error {
  override readonly name = "WireValidationFailure"
  constructor(public readonly error: WireValidationError) {
    super(error.reason)
  }
}

// ---------------------------------------------------------------------------
// Helper predicates (not exported)
// ---------------------------------------------------------------------------

function isString(v: unknown): v is string {
  return typeof v === "string"
}
function isNumber(v: unknown): v is number {
  return typeof v === "number"
}
function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean"
}
function isUint8Array(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" && v !== null && !Array.isArray(v) && !isUint8Array(v)
  )
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

function fail(
  reason: string,
  path?: readonly (string | number)[],
): Err<WireValidationError> {
  return err({ reason, path })
}

// ---------------------------------------------------------------------------
// Valid value sets
// ---------------------------------------------------------------------------

const VALID_MESSAGE_TYPES = new Set<number>([
  MessageType.Establish,
  MessageType.Depart,
  MessageType.Present,
  MessageType.Interest,
  MessageType.Offer,
  MessageType.Dismiss,
])

const VALID_PEER_TYPES = new Set<string>(["user", "bot", "service"])

const VALID_SYNC_PROTOCOLS = new Set<number>([
  SyncProtocolWire.Collaborative,
  SyncProtocolWire.Authoritative,
  SyncProtocolWire.Ephemeral,
])

const VALID_PAYLOAD_KINDS = new Set<number>([
  PayloadKind.Entirety,
  PayloadKind.Since,
])

const VALID_PAYLOAD_ENCODINGS = new Set<number>([
  PayloadEncoding.Json,
  PayloadEncoding.Binary,
])

// ---------------------------------------------------------------------------
// Per-variant validators
// ---------------------------------------------------------------------------

function validateEstablish(
  obj: Record<string, unknown>,
): Result<WireMessage, WireValidationError> {
  if (!isString(obj.id)) return fail("id must be a string", ["id"])
  if (obj.n !== undefined && !isString(obj.n))
    return fail("n must be a string", ["n"])
  if (!isString(obj.y) || !VALID_PEER_TYPES.has(obj.y))
    return fail('y must be one of "user", "bot", "service"', ["y"])
  if (obj.f !== undefined) {
    if (!isPlainObject(obj.f)) return fail("f must be an object", ["f"])
    if (obj.f.a !== undefined && !isBoolean(obj.f.a))
      return fail("f.a must be a boolean", ["f", "a"])
    if (obj.f.s !== undefined && !isBoolean(obj.f.s))
      return fail("f.s must be a boolean", ["f", "s"])
    if (obj.f.d !== undefined && !isBoolean(obj.f.d))
      return fail("f.d must be a boolean", ["f", "d"])
  }
  return ok(obj as unknown as WireMessage)
}

function validateDepart(
  obj: Record<string, unknown>,
): Result<WireMessage, WireValidationError> {
  return ok(obj as unknown as WireMessage)
}

function validatePresent(
  obj: Record<string, unknown>,
): Result<WireMessage, WireValidationError> {
  if (!Array.isArray(obj.docs)) return fail("docs must be an array", ["docs"])
  for (let i = 0; i < obj.docs.length; i++) {
    const entry: unknown = obj.docs[i]
    if (!isPlainObject(entry))
      return fail("docs entry must be an object", ["docs", i])
    if (!isString(entry.d)) return fail("d must be a string", ["docs", i, "d"])
    if (
      !Array.isArray(entry.rt) ||
      entry.rt.length !== 3 ||
      !isString(entry.rt[0]) ||
      !isNumber(entry.rt[1]) ||
      !isNumber(entry.rt[2])
    )
      return fail("rt must be a [string, number, number] tuple", [
        "docs",
        i,
        "rt",
      ])
    if (!isNumber(entry.ms) || !VALID_SYNC_PROTOCOLS.has(entry.ms))
      return fail("ms must be a valid SyncProtocolWireValue", ["docs", i, "ms"])
    if (entry.sh !== undefined && !isString(entry.sh))
      return fail("sh must be a string", ["docs", i, "sh"])
    if (entry.shx !== undefined && !isNumber(entry.shx))
      return fail("shx must be a number", ["docs", i, "shx"])
    if (entry.sa !== undefined && !isNumber(entry.sa))
      return fail("sa must be a number", ["docs", i, "sa"])
    if (entry.a !== undefined && !isNumber(entry.a))
      return fail("a must be a number", ["docs", i, "a"])
    if (entry.shs !== undefined) {
      if (
        !Array.isArray(entry.shs) ||
        !entry.shs.every((s: unknown) => isString(s))
      )
        return fail("shs must be an array of strings", ["docs", i, "shs"])
    }
    // Exactly one of sh or shx must be present
    const hasSh = entry.sh !== undefined
    const hasShx = entry.shx !== undefined
    if (hasSh === hasShx)
      return fail("exactly one of sh or shx must be present", ["docs", i])
  }
  return ok(obj as unknown as WireMessage)
}

function validateDocOrDx(
  obj: Record<string, unknown>,
  variant: string,
): Result<void, WireValidationError> {
  if (obj.doc !== undefined && !isString(obj.doc))
    return fail("doc must be a string", ["doc"])
  if (obj.dx !== undefined && !isNumber(obj.dx))
    return fail("dx must be a number", ["dx"])
  const hasDoc = obj.doc !== undefined
  const hasDx = obj.dx !== undefined
  if (hasDoc === hasDx)
    return fail(`${variant}: exactly one of doc or dx must be present`)
  return ok(undefined)
}

function validateInterest(
  obj: Record<string, unknown>,
): Result<WireMessage, WireValidationError> {
  const docCheck = validateDocOrDx(obj, "interest")
  if (!docCheck.ok) return docCheck
  if (obj.v !== undefined && !isString(obj.v))
    return fail("v must be a string", ["v"])
  if (obj.r !== undefined && !isBoolean(obj.r))
    return fail("r must be a boolean", ["r"])
  return ok(obj as unknown as WireMessage)
}

function validateOffer(
  obj: Record<string, unknown>,
): Result<WireMessage, WireValidationError> {
  const docCheck = validateDocOrDx(obj, "offer")
  if (!docCheck.ok) return docCheck
  if (!isNumber(obj.pk) || !VALID_PAYLOAD_KINDS.has(obj.pk))
    return fail("pk must be a valid PayloadKindValue", ["pk"])
  if (!isNumber(obj.pe) || !VALID_PAYLOAD_ENCODINGS.has(obj.pe))
    return fail("pe must be a valid PayloadEncodingValue", ["pe"])
  if (!isString(obj.d) && !isUint8Array(obj.d))
    return fail("d must be a string or Uint8Array", ["d"])
  if (!isString(obj.v)) return fail("v must be a string", ["v"])
  if (obj.r !== undefined && !isBoolean(obj.r))
    return fail("r must be a boolean", ["r"])
  return ok(obj as unknown as WireMessage)
}

function validateDismiss(
  obj: Record<string, unknown>,
): Result<WireMessage, WireValidationError> {
  const docCheck = validateDocOrDx(obj, "dismiss")
  if (!docCheck.ok) return docCheck
  return ok(obj as unknown as WireMessage)
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

const validators: Record<
  MessageTypeValue,
  (obj: Record<string, unknown>) => Result<WireMessage, WireValidationError>
> = {
  [MessageType.Establish]: validateEstablish,
  [MessageType.Depart]: validateDepart,
  [MessageType.Present]: validatePresent,
  [MessageType.Interest]: validateInterest,
  [MessageType.Offer]: validateOffer,
  [MessageType.Dismiss]: validateDismiss,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function validateWireMessage(
  obj: unknown,
): Result<WireMessage, WireValidationError> {
  if (!isPlainObject(obj)) return fail("input must be a non-null object")
  if (!isNumber(obj.t) || !VALID_MESSAGE_TYPES.has(obj.t))
    return fail("t must be a valid MessageTypeValue", ["t"])
  return validators[obj.t as MessageTypeValue](obj)
}
