// validate-identifiers — UTF-8 byte-length validation for wire identifiers.
//
// DocIds and schema hashes have explicit caps (DOC_ID_MAX_UTF8_BYTES,
// SCHEMA_HASH_MAX_UTF8_BYTES). The unit is bytes — multi-byte UTF-8
// characters count proportionally to their encoded byte length.
//
// Validation runs at decode time on every message that names a doc or
// schema. The binary codec sees byte length natively (the value is
// already a string of UTF-8 codepoints in the JS runtime); the text
// codec computes byte length from the JS string via TextEncoder.
//
// On overflow, `FrameDecodeError` (binary) or `TextFrameDecodeError`
// (text) is thrown with a `code` of `"doc-id-too-long"` or
// `"schema-hash-too-long"`.

import {
  DOC_ID_MAX_UTF8_BYTES,
  SCHEMA_HASH_MAX_UTF8_BYTES,
} from "./constants.js"

const utf8Encoder = new TextEncoder()

export function utf8ByteLength(s: string): number {
  return utf8Encoder.encode(s).byteLength
}

export type IdentifierValidationError = {
  code: "doc-id-too-long" | "schema-hash-too-long"
  message: string
}

/**
 * Validate a single docId. Returns an error description when the value
 * exceeds the cap. Caller decides how to surface (FrameDecodeError vs
 * TextFrameDecodeError).
 */
export function validateDocId(value: string): IdentifierValidationError | null {
  const len = utf8ByteLength(value)
  if (len > DOC_ID_MAX_UTF8_BYTES) {
    return {
      code: "doc-id-too-long",
      message: `DocId exceeds ${DOC_ID_MAX_UTF8_BYTES} UTF-8 bytes (got ${len})`,
    }
  }
  return null
}

/**
 * Validate a single schema hash.
 */
export function validateSchemaHash(
  value: string,
): IdentifierValidationError | null {
  const len = utf8ByteLength(value)
  if (len > SCHEMA_HASH_MAX_UTF8_BYTES) {
    return {
      code: "schema-hash-too-long",
      message: `SchemaHash exceeds ${SCHEMA_HASH_MAX_UTF8_BYTES} UTF-8 bytes (got ${len})`,
    }
  }
  return null
}
