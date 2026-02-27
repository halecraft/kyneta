import { describe, expect, it } from "vitest"
import {
  BindingError,
  CompilerError,
  HydrationMismatchError,
  InvalidMountTargetError,
  KineticError,
  KineticErrorCode,
  ScopeDisposedError,
} from "./errors.js"

describe("KineticError", () => {
  it("should create error with code and message", () => {
    const error = new KineticError(
      KineticErrorCode.SUBSCRIPTION_ERROR,
      "Test error",
    )
    expect(error.code).toBe(KineticErrorCode.SUBSCRIPTION_ERROR)
    expect(error.message).toBe("Test error")
    expect(error.name).toBe("KineticError")
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(KineticError)
  })

  it("should have proper stack trace", () => {
    const error = new KineticError(
      KineticErrorCode.SUBSCRIPTION_ERROR,
      "Test error",
    )
    expect(error.stack).toBeDefined()
    expect(error.stack).toContain("KineticError")
  })
})

describe("CompilerError", () => {
  it("should create error without location", () => {
    const error = new CompilerError(
      KineticErrorCode.COMPILER_PARSE_ERROR,
      "Parse failed",
    )
    expect(error.code).toBe(KineticErrorCode.COMPILER_PARSE_ERROR)
    expect(error.message).toBe("Parse failed")
    expect(error.location).toBeUndefined()
    expect(error.name).toBe("CompilerError")
    expect(error).toBeInstanceOf(KineticError)
  })

  it("should create error with location", () => {
    const location = { file: "test.ts", line: 10, column: 5 }
    const error = new CompilerError(
      KineticErrorCode.COMPILER_TRANSFORM_ERROR,
      "Transform failed",
      location,
    )
    expect(error.code).toBe(KineticErrorCode.COMPILER_TRANSFORM_ERROR)
    expect(error.message).toBe("Transform failed at test.ts:10:5")
    expect(error.location).toEqual(location)
  })
})

describe("HydrationMismatchError", () => {
  it("should create error with expected and actual values", () => {
    const error = new HydrationMismatchError("hello", "world")
    expect(error.code).toBe(KineticErrorCode.HYDRATION_MISMATCH)
    expect(error.message).toBe(
      'Hydration mismatch: expected "hello", got "world"',
    )
    expect(error.expected).toBe("hello")
    expect(error.actual).toBe("world")
    expect(error.name).toBe("HydrationMismatchError")
    expect(error).toBeInstanceOf(KineticError)
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
    const error = new ScopeDisposedError("scope-123")
    expect(error.code).toBe(KineticErrorCode.SCOPE_DISPOSED)
    expect(error.scopeId).toBe("scope-123")
    expect(error.message).toContain("scope-123")
    expect(error.message).toContain("disposed")
    expect(error.name).toBe("ScopeDisposedError")
    expect(error).toBeInstanceOf(KineticError)
  })
})

describe("InvalidMountTargetError", () => {
  it("should create error with message", () => {
    const error = new InvalidMountTargetError("Target must be an Element")
    expect(error.code).toBe(KineticErrorCode.INVALID_MOUNT_TARGET)
    expect(error.message).toBe("Target must be an Element")
    expect(error.name).toBe("InvalidMountTargetError")
    expect(error).toBeInstanceOf(KineticError)
  })
})

describe("BindingError", () => {
  it("should create error with code and message", () => {
    const error = new BindingError(
      KineticErrorCode.BINDING_INVALID_TARGET,
      "Cannot bind to non-input element",
    )
    expect(error.code).toBe(KineticErrorCode.BINDING_INVALID_TARGET)
    expect(error.message).toBe("Cannot bind to non-input element")
    expect(error.name).toBe("BindingError")
    expect(error).toBeInstanceOf(KineticError)
  })
})

describe("KineticErrorCode", () => {
  it("should have unique values for all codes", () => {
    const codes = Object.values(KineticErrorCode).filter(
      v => typeof v === "number",
    )
    const uniqueCodes = new Set(codes)
    expect(uniqueCodes.size).toBe(codes.length)
  })

  it("should have compiler errors in 100 range", () => {
    expect(KineticErrorCode.COMPILER_PARSE_ERROR).toBeGreaterThanOrEqual(100)
    expect(KineticErrorCode.COMPILER_PARSE_ERROR).toBeLessThan(200)
    expect(KineticErrorCode.COMPILER_TRANSFORM_ERROR).toBeGreaterThanOrEqual(
      100,
    )
    expect(KineticErrorCode.COMPILER_TRANSFORM_ERROR).toBeLessThan(200)
  })

  it("should have runtime errors in 200 range", () => {
    expect(KineticErrorCode.SCOPE_DISPOSED).toBeGreaterThanOrEqual(200)
    expect(KineticErrorCode.SCOPE_DISPOSED).toBeLessThan(300)
    expect(KineticErrorCode.INVALID_MOUNT_TARGET).toBeGreaterThanOrEqual(200)
    expect(KineticErrorCode.INVALID_MOUNT_TARGET).toBeLessThan(300)
  })

  it("should have hydration errors in 300 range", () => {
    expect(KineticErrorCode.HYDRATION_MISMATCH).toBeGreaterThanOrEqual(300)
    expect(KineticErrorCode.HYDRATION_MISMATCH).toBeLessThan(400)
  })

  it("should have binding errors in 400 range", () => {
    expect(KineticErrorCode.BINDING_INVALID_TARGET).toBeGreaterThanOrEqual(400)
    expect(KineticErrorCode.BINDING_INVALID_TARGET).toBeLessThan(500)
  })
})
