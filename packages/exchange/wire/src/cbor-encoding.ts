// cbor-encoding — minimal CBOR encoder/decoder for @kyneta/wire.
//
// Replaces @levischuck/tiny-cbor, fixing two bugs:
//   1. encodeString used JS .length (UTF-16 code units) instead of UTF-8 byte
//      length for the CBOR text string header — corrupting any non-ASCII string.
//   2. decodePartialCBOR constructed DataView without byteOffset, so Uint8Array
//      views into shared ArrayBuffers (e.g. Node.js pooled Buffers) would read
//      from the wrong position.
//
// Implements RFC 8949 major types 0–7. No CBOR tags (major type 6) — kyneta
// doesn't use them. No indefinite-length encoding.

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

/**
 * CBOR-encodable value. Matches the subset of CBOR types kyneta uses.
 */
export type CBORType =
  | number
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | undefined
  | CBORType[]
  | Map<string | number, CBORType>

// ---------------------------------------------------------------------------
// CBOR major types
// ---------------------------------------------------------------------------

const MAJOR_UNSIGNED = 0
const MAJOR_NEGATIVE = 1
const MAJOR_BYTE_STRING = 2
const MAJOR_TEXT_STRING = 3
const MAJOR_ARRAY = 4
const MAJOR_MAP = 5
// const MAJOR_TAG = 6  — not used
const MAJOR_SIMPLE = 7

// ---------------------------------------------------------------------------
// Shared codec instances
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/**
 * Encode a CBOR length/argument into the compact variable-width format.
 *
 * Returns an array of byte values (numbers) representing the encoded
 * major-type byte plus any additional length bytes.
 */
function encodeLength(major: number, argument: number | bigint): number[] {
  const m = major << 5

  let big: bigint
  if (typeof argument === "number") {
    big = BigInt(argument)
  } else {
    big = argument
  }

  // Negative integers: CBOR encodes the absolute value minus one
  if (major === MAJOR_NEGATIVE) {
    if (big === 0n) {
      throw new Error("CBOR negative integer argument cannot be zero")
    }
    big = big - 1n
  }

  if (big > 0xffff_ffff_ffff_ffffn) {
    throw new Error("CBOR number out of range")
  }

  // Encode into 8 bytes big-endian then slice the tail
  const buf = new Uint8Array(8)
  const view = new DataView(buf.buffer)
  view.setBigUint64(0, big, false)

  if (big <= 23n) {
    return [m | buf[7]!]
  }
  if (big <= 0xffn) {
    return [m | 24, buf[7]!]
  }
  if (big <= 0xffffn) {
    return [m | 25, buf[6]!, buf[7]!]
  }
  if (big <= 0xffff_ffffn) {
    return [m | 26, buf[4]!, buf[5]!, buf[6]!, buf[7]!]
  }
  return [
    m | 27,
    buf[0]!,
    buf[1]!,
    buf[2]!,
    buf[3]!,
    buf[4]!,
    buf[5]!,
    buf[6]!,
    buf[7]!,
  ]
}

function encodeNumber(
  data: number | bigint,
  output: (number | Uint8Array)[],
): void {
  if (typeof data === "number") {
    if (Number.isSafeInteger(data)) {
      if (data < 0) {
        output.push(...encodeLength(MAJOR_NEGATIVE, Math.abs(data)))
      } else {
        output.push(...encodeLength(MAJOR_UNSIGNED, data))
      }
    } else {
      output.push(encodeFloat(data))
    }
  } else {
    // bigint
    if (data < 0n) {
      output.push(...encodeLength(MAJOR_NEGATIVE, -data))
    } else {
      output.push(...encodeLength(MAJOR_UNSIGNED, data))
    }
  }
}

function encodeFloat(data: number): Uint8Array<ArrayBuffer> {
  if (
    Math.fround(data) === data ||
    !Number.isFinite(data) ||
    Number.isNaN(data)
  ) {
    const out = new Uint8Array(5)
    out[0] = 0xfa // major 7, additional 26 (float32)
    const view = new DataView(out.buffer)
    view.setFloat32(1, data, false)
    return out
  }
  const out = new Uint8Array(9)
  out[0] = 0xfb // major 7, additional 27 (float64)
  const view = new DataView(out.buffer)
  view.setFloat64(1, data, false)
  return out
}

function encodeString(data: string, output: (number | Uint8Array)[]): void {
  // THE CRITICAL FIX: encode first, then use the UTF-8 byte length for the header.
  // tiny-cbor used `data.length` (UTF-16 code units) which diverges for non-ASCII.
  const utf8 = TEXT_ENCODER.encode(data)
  output.push(...encodeLength(MAJOR_TEXT_STRING, utf8.byteLength))
  output.push(utf8)
}

function encodeBytes(data: Uint8Array, output: (number | Uint8Array)[]): void {
  output.push(...encodeLength(MAJOR_BYTE_STRING, data.byteLength))
  output.push(data)
}

function encodeArray(data: CBORType[], output: (number | Uint8Array)[]): void {
  output.push(...encodeLength(MAJOR_ARRAY, data.length))
  for (const item of data) {
    encodeValue(item, output)
  }
}

function encodeMap(
  data: Map<string | number, CBORType>,
  output: (number | Uint8Array)[],
): void {
  output.push(...encodeLength(MAJOR_MAP, data.size))
  for (const [key, value] of data.entries()) {
    encodeValue(key, output)
    encodeValue(value, output)
  }
}

function encodeSimple(data: boolean | null | undefined): number {
  if (data === true) return 0xf5
  if (data === false) return 0xf4
  if (data === null) return 0xf6
  return 0xf7 // undefined
}

function encodeValue(data: CBORType, output: (number | Uint8Array)[]): void {
  if (typeof data === "boolean" || data === null || data === undefined) {
    output.push(encodeSimple(data))
    return
  }
  if (typeof data === "number" || typeof data === "bigint") {
    encodeNumber(data, output)
    return
  }
  if (typeof data === "string") {
    encodeString(data, output)
    return
  }
  if (data instanceof Uint8Array) {
    encodeBytes(data, output)
    return
  }
  if (Array.isArray(data)) {
    encodeArray(data, output)
    return
  }
  if (data instanceof Map) {
    encodeMap(data, output)
    return
  }
  throw new Error("CBOR encode: unsupported type")
}

/**
 * Encode a value to a CBOR byte string.
 *
 * Returns `Uint8Array<ArrayBuffer>` (not `Uint8Array<ArrayBufferLike>`)
 * so downstream WebSocket `.send` paths that reject SharedArrayBuffer
 * (Bun, Hono) can accept the result without a cast.
 */
export function encodeCBOR(data: CBORType): Uint8Array<ArrayBuffer> {
  const parts: (number | Uint8Array)[] = []
  encodeValue(data, parts)

  // Calculate total length
  let length = 0
  for (const part of parts) {
    length += typeof part === "number" ? 1 : part.byteLength
  }

  // Concatenate into a single Uint8Array
  const output = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    if (typeof part === "number") {
      output[offset++] = part
    } else {
      output.set(part, offset)
      offset += part.byteLength
    }
  }
  return output
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/**
 * Decode a CBOR length/argument from the byte stream.
 *
 * Returns [value, bytesConsumed]. The `argument` is the lower 5 bits
 * of the initial byte (already extracted by the caller).
 */
function decodeLength(
  view: DataView,
  argument: number,
  index: number,
): [number | bigint, number] {
  if (argument < 24) {
    return [argument, 1]
  }

  const remaining = view.byteLength - index - 1

  switch (argument) {
    case 24: {
      if (remaining < 1) break
      const val = view.getUint8(index + 1)
      if (val >= 24) return [val, 2]
      break
    }
    case 25: {
      if (remaining < 2) break
      const val = view.getUint16(index + 1, false)
      if (val >= 24) return [val, 3]
      break
    }
    case 26: {
      if (remaining < 4) break
      const val = view.getUint32(index + 1, false)
      if (val >= 24) return [val, 5]
      break
    }
    case 27: {
      if (remaining < 8) break
      const big = view.getBigUint64(index + 1, false)
      if (big >= 24n && big <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return [Number(big), 9]
      }
      if (big >= 24n) {
        return [big, 9]
      }
      break
    }
  }

  throw new Error("Length not supported or not well formed")
}

function decodeUnsignedInteger(
  view: DataView,
  argument: number,
  index: number,
): [number | bigint, number] {
  return decodeLength(view, argument, index)
}

function decodeNegativeInteger(
  view: DataView,
  argument: number,
  index: number,
): [number | bigint, number] {
  const [value, length] = decodeLength(view, argument, index)
  if (typeof value === "bigint") {
    return [-value - 1n, length]
  }
  return [-value - 1, length]
}

function decodeByteString(
  view: DataView,
  argument: number,
  index: number,
  baseOffset: number,
  data: Uint8Array,
): [Uint8Array, number] {
  const [lengthValue, lengthConsumed] = decodeLength(view, argument, index)
  if (typeof lengthValue === "bigint") {
    throw new Error("Byte string length too large")
  }
  const start = index + lengthConsumed - baseOffset
  return [data.slice(start, start + lengthValue), lengthConsumed + lengthValue]
}

function decodeTextString(
  view: DataView,
  argument: number,
  index: number,
  baseOffset: number,
  data: Uint8Array,
): [string, number] {
  const [bytes, consumed] = decodeByteString(
    view,
    argument,
    index,
    baseOffset,
    data,
  )
  return [TEXT_DECODER.decode(bytes), consumed]
}

function decodeArray(
  view: DataView,
  argument: number,
  index: number,
  baseOffset: number,
  data: Uint8Array,
): [CBORType[], number] {
  if (argument === 0) {
    return [[], 1]
  }
  const [length, lengthConsumed] = decodeLength(view, argument, index)
  if (typeof length === "bigint") {
    throw new Error("Array length too large")
  }
  let consumed = lengthConsumed
  const result: CBORType[] = []
  for (let i = 0; i < length; i++) {
    if (index + consumed >= baseOffset + data.byteLength) {
      throw new Error("Array is not well formed")
    }
    const [value, valueConsumed] = decodeNext(
      view,
      index + consumed,
      baseOffset,
      data,
    )
    result.push(value)
    consumed += valueConsumed
  }
  return [result, consumed]
}

function decodeMap(
  view: DataView,
  argument: number,
  index: number,
  baseOffset: number,
  data: Uint8Array,
): [Map<string | number, CBORType>, number] {
  if (argument === 0) {
    return [new Map(), 1]
  }
  const [length, lengthConsumed] = decodeLength(view, argument, index)
  if (typeof length === "bigint") {
    throw new Error("Map length too large")
  }
  let consumed = lengthConsumed
  const result = new Map<string | number, CBORType>()
  for (let i = 0; i < length; i++) {
    const end = baseOffset + data.byteLength
    if (index + consumed >= end) {
      throw new Error("Map is not well formed")
    }
    const [key, keyConsumed] = decodeNext(
      view,
      index + consumed,
      baseOffset,
      data,
    )
    consumed += keyConsumed
    if (typeof key !== "string" && typeof key !== "number") {
      throw new Error("Map key must be string or number")
    }
    if (index + consumed >= end) {
      throw new Error("Map is not well formed")
    }
    if (result.has(key)) {
      throw new Error("Map has duplicate key")
    }
    const [value, valueConsumed] = decodeNext(
      view,
      index + consumed,
      baseOffset,
      data,
    )
    consumed += valueConsumed
    result.set(key, value)
  }
  return [result, consumed]
}

function decodeFloat16(view: DataView, index: number): [number, number] {
  if (index + 3 > view.byteLength) {
    throw new Error("CBOR stream ended before float16")
  }
  const bits = view.getUint16(index + 1, false)
  // Only support ±Infinity and NaN — matching tiny-cbor's behavior
  if (bits === 0x7c00) return [Infinity, 3]
  if (bits === 0x7e00) return [NaN, 3]
  if (bits === 0xfc00) return [-Infinity, 3]
  throw new Error(
    "Float16 values other than ±Infinity and NaN are not supported",
  )
}

function decodeFloat32(view: DataView, index: number): [number, number] {
  if (index + 5 > view.byteLength) {
    throw new Error("CBOR stream ended before float32")
  }
  return [view.getFloat32(index + 1, false), 5]
}

function decodeFloat64(view: DataView, index: number): [number, number] {
  if (index + 9 > view.byteLength) {
    throw new Error("CBOR stream ended before float64")
  }
  return [view.getFloat64(index + 1, false), 9]
}

function decodeNext(
  view: DataView,
  index: number,
  baseOffset: number,
  data: Uint8Array,
): [CBORType, number] {
  if (index >= baseOffset + data.byteLength) {
    throw new Error("CBOR stream ended unexpectedly")
  }
  const byte = view.getUint8(index)
  const major = byte >> 5
  const argument = byte & 0x1f

  switch (major) {
    case MAJOR_UNSIGNED:
      return decodeUnsignedInteger(view, argument, index)
    case MAJOR_NEGATIVE:
      return decodeNegativeInteger(view, argument, index)
    case MAJOR_BYTE_STRING:
      return decodeByteString(view, argument, index, baseOffset, data)
    case MAJOR_TEXT_STRING:
      return decodeTextString(view, argument, index, baseOffset, data)
    case MAJOR_ARRAY:
      return decodeArray(view, argument, index, baseOffset, data)
    case MAJOR_MAP:
      return decodeMap(view, argument, index, baseOffset, data)
    case MAJOR_SIMPLE: {
      switch (argument) {
        case 20:
          return [false, 1]
        case 21:
          return [true, 1]
        case 22:
          return [null, 1]
        case 23:
          return [undefined, 1]
        case 25:
          return decodeFloat16(view, index)
        case 26:
          return decodeFloat32(view, index)
        case 27:
          return decodeFloat64(view, index)
      }
    }
  }

  throw new Error(`Unsupported CBOR type at index ${index - baseOffset}`)
}

/**
 * Decode a complete CBOR payload from a Uint8Array.
 *
 * The entire byte stream must be consumed — if there are trailing bytes
 * after the decoded value, an error is thrown.
 *
 * Constructs DataView with byteOffset-correct arguments so that
 * Uint8Array views into shared ArrayBuffers (e.g. Node.js pooled
 * Buffers) are handled correctly.
 */
export function decodeCBOR(data: Uint8Array): CBORType {
  if (data.byteLength === 0) {
    throw new Error("No data")
  }

  // byteOffset-correct DataView construction — fixes tiny-cbor's latent bug
  // where `new DataView(data.buffer)` without offset would read from the
  // wrong position for Uint8Array views with non-zero byteOffset.
  //
  // The DataView is scoped to [data.byteOffset, data.byteOffset + data.byteLength),
  // so all indices within the view are 0-based. The `baseOffset` passed to
  // decodeNext is 0 because `data.slice()` is also 0-based relative to the
  // Uint8Array's own content, regardless of its byteOffset into the ArrayBuffer.
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  const [value, consumed] = decodeNext(view, 0, 0, data)

  if (consumed !== data.byteLength) {
    throw new Error(
      `CBOR decode: trailing data (${consumed} bytes consumed, ${data.byteLength} bytes total)`,
    )
  }

  return value
}
