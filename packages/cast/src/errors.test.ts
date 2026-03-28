import { describe, expect, it } from "vitest"
import {
  BindingError,
  CompilerError,
  HydrationMismatchError,
  InvalidMountTargetError,
  KynetaError,
  KynetaErrorCode,
  ScopeDisposedError,
} from "./errors.js"

describe("KynetaError", () => {
  it("should create error with code and message", () => {
    const error = new KynetaError(
      KynetaErrorCode.SUBSCRIPTION_ERROR,
      "Test error",
    )
    expect(error.code).toBe(KynetaErrorCode.SUBSCRIPTION_ERROR)
    expect(error.message).toBe("Test error")
    expect(error.name).toBe("KynetaError")
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(KynetaError)
  })

  it("should have proper stack trace", () => {
    const error = new KynetaError(
      KynetaErrorCode.SUBSCRIPTION_ERROR,
      "Test error",
    )
    expect(error.stack).toBeDefined()
    expect(error.stack).toContain("KynetaError")
  })
})

describe("CompilerError", () => {
  it("should create error without location", () => {
    const error = new CompilerError(
      KynetaErrorCode.COMPILER_PARSE_ERROR,
      "Parse failed",
    )
    expect(error.code).toBe(KynetaErrorCode.COMPILER_PARSE_ERROR)
    expect(error.message).toBe("Parse failed")
    expect(error.location).toBeUndefined()
    expect(error.name).toBe("CompilerError")
    expect(error).toBeInstanceOf(KynetaError)
  })

  it("should create error with location", () => {
    const location = { file: "test.ts", line: 10, column: 5 }
    const error = new CompilerError(
      KynetaErrorCode.COMPILER_TRANSFORM_ERROR,
      "Transform failed",
      location,
    )
    expect(error.code).toBe(KynetaErrorCode.COMPILER_TRANSFORM_ERROR)
    expect(error.message).toBe("Transform failed at test.ts:10:5")
    expect(error.location).toEqual(location)
  })
})

describe("HydrationMismatchError", () => {
  it("should create error with expected and actual values", () => {
    const error = new HydrationMismatchError("hello", "world")
    expect(error.code).toBe(KynetaErrorCode.HYDRATION_MISMATCH)
    expect(error.message).toBe(
      'Hydration mismatch: expected "hello", got "world"',
    )
    expect(error.expected).toBe("hello")
    expect(error.actual).toBe("world")
    expect(error.name).toBe("HydrationMismatchError")
    expect(error).toBeInstanceOf(KynetaError)
  })

  it("should include context when provided", () => {
    const error = new HydrationMismatchError("div", "span", "element type")
    expect(error.message).toBe(
      'Hydration mismatch (element type): expected "div", got "span"',
    )
  })
})

describe("ScopeDisposedError", () => {
  it("should create error with scope ID", () => {
    const error = new ScopeDisposedError(123)
    expect(error.code).toBe(KynetaErrorCode.SCOPE_DISPOSED)
    expect(error.scopeId).toBe(123)
    expect(error.message).toContain("123")
    expect(error.message).toContain("disposed")
    expect(error.name).toBe("ScopeDisposedError")
    expect(error).toBeInstanceOf(KynetaError)
  })
})

describe("InvalidMountTargetError", () => {
  it("should create error with message", () => {
    const error = new InvalidMountTargetError("Target must be an Element")
    expect(error.code).toBe(KynetaErrorCode.INVALID_MOUNT_TARGET)
    expect(error.message).toBe("Target must be an Element")
    expect(error.name).toBe("InvalidMountTargetError")
    expect(error).toBeInstanceOf(KynetaError)
  })
})

describe("BindingError", () => {
  it("should create error with code and message", () => {
    const error = new BindingError(
      KynetaErrorCode.BINDING_INVALID_TARGET,
      "Cannot bind to non-input element",
    )
    expect(error.code).toBe(KynetaErrorCode.BINDING_INVALID_TARGET)
    expect(error.message).toBe("Cannot bind to non-input element")
    expect(error.name).toBe("BindingError")
    expect(error).toBeInstanceOf(KynetaError)
  })
})

describe("KynetaErrorCode", () => {
  it("should have unique values for all codes", () => {
    const codes = Object.values(KynetaErrorCode).filter(
      v => typeof v === "number",
    )
    const uniqueCodes = new Set(codes)
    expect(uniqueCodes.size).toBe(codes.length)
  })

  it("should have compiler errors in 100 range", () => {
    expect(KynetaErrorCode.COMPILER_PARSE_ERROR).toBeGreaterThanOrEqual(100)
    expect(KynetaErrorCode.COMPILER_PARSE_ERROR).toBeLessThan(200)
    expect(KynetaErrorCode.COMPILER_TRANSFORM_ERROR).toBeGreaterThanOrEqual(100)
    expect(KynetaErrorCode.COMPILER_TRANSFORM_ERROR).toBeLessThan(200)
  })

  it("should have runtime errors in 200 range", () => {
    expect(KynetaErrorCode.SCOPE_DISPOSED).toBeGreaterThanOrEqual(200)
    expect(KynetaErrorCode.SCOPE_DISPOSED).toBeLessThan(300)
    expect(KynetaErrorCode.INVALID_MOUNT_TARGET).toBeGreaterThanOrEqual(200)
    expect(KynetaErrorCode.INVALID_MOUNT_TARGET).toBeLessThan(300)
  })

  it("should have hydration errors in 300 range", () => {
    expect(KynetaErrorCode.HYDRATION_MISMATCH).toBeGreaterThanOrEqual(300)
    expect(KynetaErrorCode.HYDRATION_MISMATCH).toBeLessThan(400)
  })

  it("should have binding errors in 400 range", () => {
    expect(KynetaErrorCode.BINDING_INVALID_TARGET).toBeGreaterThanOrEqual(400)
    expect(KynetaErrorCode.BINDING_INVALID_TARGET).toBeLessThan(500)
  })
})
