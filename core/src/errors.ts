/**
 * Error taxonomy for Kinetic.
 *
 * All errors extend KineticError with a unique error code for programmatic handling.
 */

/**
 * Error codes for all Kinetic errors.
 */
export enum KineticErrorCode {
  // Compiler errors (1xx)
  COMPILER_PARSE_ERROR = 100,
  COMPILER_TRANSFORM_ERROR = 101,
  COMPILER_TYPE_ERROR = 102,
  COMPILER_UNSUPPORTED_SYNTAX = 103,

  // Runtime errors (2xx)
  SCOPE_DISPOSED = 200,
  INVALID_MOUNT_TARGET = 201,
  SUBSCRIPTION_ERROR = 202,

  // Hydration errors (3xx)
  HYDRATION_MISMATCH = 300,
  HYDRATION_MISSING_MARKER = 301,
  HYDRATION_INVALID_STATE = 302,

  // Binding errors (4xx)
  BINDING_INVALID_TARGET = 400,
  BINDING_TYPE_MISMATCH = 401,
}

/**
 * Base error class for all Kinetic errors.
 */
export class KineticError extends Error {
  readonly code: KineticErrorCode

  constructor(code: KineticErrorCode, message: string) {
    super(message)
    this.name = "KineticError"
    this.code = code
  }
}

/**
 * Source location for compiler errors.
 */
export interface SourceLocation {
  file: string
  line: number
  column: number
}

/**
 * Error thrown during compilation.
 * Includes source location information for IDE integration.
 */
export class CompilerError extends KineticError {
  readonly location: SourceLocation | undefined

  constructor(
    code: KineticErrorCode,
    message: string,
    location?: SourceLocation,
  ) {
    const locationStr = location
      ? ` at ${location.file}:${location.line}:${location.column}`
      : ""
    super(code, `${message}${locationStr}`)
    this.name = "CompilerError"
    this.location = location
  }
}

/**
 * Error thrown when hydration fails due to server/client mismatch.
 * This should be rare with CRDT state, but can occur with stale HTML.
 */
export class HydrationMismatchError extends KineticError {
  readonly expected: string
  readonly actual: string

  constructor(expected: string, actual: string, context?: string) {
    const contextStr = context ? ` (${context})` : ""
    super(
      KineticErrorCode.HYDRATION_MISMATCH,
      `Hydration mismatch${contextStr}: expected "${expected}", got "${actual}"`,
    )
    this.name = "HydrationMismatchError"
    this.expected = expected
    this.actual = actual
  }
}

/**
 * Error thrown when attempting to use a disposed scope.
 * This indicates a use-after-dispose bug, typically from
 * stale closures referencing a cleaned-up region.
 */
export class ScopeDisposedError extends KineticError {
  readonly scopeId: number

  constructor(scopeId: number) {
    super(
      KineticErrorCode.SCOPE_DISPOSED,
      `Scope ${scopeId} has been disposed. This usually indicates a stale closure referencing a cleaned-up region.`,
    )
    this.name = "ScopeDisposedError"
    this.scopeId = scopeId
  }
}

/**
 * Error thrown when mount() is called with an invalid target.
 */
export class InvalidMountTargetError extends KineticError {
  constructor(message: string) {
    super(KineticErrorCode.INVALID_MOUNT_TARGET, message)
    this.name = "InvalidMountTargetError"
  }
}

/**
 * Error thrown when binding fails (e.g., wrong element type, invalid ref).
 */
export class BindingError extends KineticError {
  constructor(code: KineticErrorCode, message: string) {
    super(code, message)
    this.name = "BindingError"
  }
}
