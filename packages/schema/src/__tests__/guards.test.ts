import { describe, expect, it } from "vitest"
import {
  CHANGEFEED,
  hasChangefeed,
  isNonNullObject,
  isPropertyHost,
} from "../index.js"

// ===========================================================================
// isPropertyHost — accepts objects AND functions
// ===========================================================================

describe("isPropertyHost", () => {
  it("returns true for plain objects", () => {
    expect(isPropertyHost({})).toBe(true)
    expect(isPropertyHost({ a: 1 })).toBe(true)
  })

  it("returns true for arrays", () => {
    expect(isPropertyHost([])).toBe(true)
    expect(isPropertyHost([1, 2, 3])).toBe(true)
  })

  it("returns true for regular functions", () => {
    expect(isPropertyHost(() => {})).toBe(true)
  })

  it("returns true for arrow functions", () => {
    expect(isPropertyHost(() => {})).toBe(true)
  })

  it("returns true for class instances", () => {
    class Foo {}
    expect(isPropertyHost(new Foo())).toBe(true)
  })

  it("returns true for functions with properties", () => {
    const fn = () => 42
    ;(fn as any).label = "test"
    expect(isPropertyHost(fn)).toBe(true)
  })

  it("returns false for null", () => {
    expect(isPropertyHost(null)).toBe(false)
  })

  it("returns false for undefined", () => {
    expect(isPropertyHost(undefined)).toBe(false)
  })

  it("returns false for numbers", () => {
    expect(isPropertyHost(42)).toBe(false)
    expect(isPropertyHost(0)).toBe(false)
    expect(isPropertyHost(NaN)).toBe(false)
  })

  it("returns false for strings", () => {
    expect(isPropertyHost("hello")).toBe(false)
    expect(isPropertyHost("")).toBe(false)
  })

  it("returns false for booleans", () => {
    expect(isPropertyHost(true)).toBe(false)
    expect(isPropertyHost(false)).toBe(false)
  })

  it("returns false for symbols", () => {
    expect(isPropertyHost(Symbol("test"))).toBe(false)
  })

  it("returns false for bigints", () => {
    expect(isPropertyHost(BigInt(42))).toBe(false)
  })
})

// ===========================================================================
// isNonNullObject — unchanged behavior (still false for functions)
// ===========================================================================

describe("isNonNullObject (unchanged)", () => {
  it("returns true for plain objects", () => {
    expect(isNonNullObject({})).toBe(true)
  })

  it("returns true for arrays", () => {
    expect(isNonNullObject([])).toBe(true)
  })

  it("returns false for functions", () => {
    expect(isNonNullObject(() => {})).toBe(false)
    expect(isNonNullObject(() => {})).toBe(false)
  })

  it("returns false for null", () => {
    expect(isNonNullObject(null)).toBe(false)
  })

  it("returns false for primitives", () => {
    expect(isNonNullObject(42)).toBe(false)
    expect(isNonNullObject("hello")).toBe(false)
    expect(isNonNullObject(true)).toBe(false)
    expect(isNonNullObject(undefined)).toBe(false)
  })
})

// ===========================================================================
// hasChangefeed — accepts functions with [CHANGEFEED]
// ===========================================================================

describe("hasChangefeed with functions", () => {
  it("returns true for a function with [CHANGEFEED] attached", () => {
    const fn = () => 42
    Object.defineProperty(fn, CHANGEFEED, {
      value: {
        get current() {
          return 42
        },
        subscribe: () => () => {},
      },
      enumerable: false,
      configurable: true,
    })
    expect(hasChangefeed(fn)).toBe(true)
  })

  it("returns false for a plain function without [CHANGEFEED]", () => {
    const fn = () => 42
    expect(hasChangefeed(fn)).toBe(false)
  })

  it("still returns true for objects with [CHANGEFEED]", () => {
    const obj: Record<symbol, unknown> = {}
    Object.defineProperty(obj, CHANGEFEED, {
      value: {
        get current() {
          return "hello"
        },
        subscribe: () => () => {},
      },
      enumerable: false,
      configurable: true,
    })
    expect(hasChangefeed(obj)).toBe(true)
  })

  it("still returns false for null", () => {
    expect(hasChangefeed(null)).toBe(false)
  })

  it("still returns false for undefined", () => {
    expect(hasChangefeed(undefined)).toBe(false)
  })

  it("still returns false for primitives", () => {
    expect(hasChangefeed(42)).toBe(false)
    expect(hasChangefeed("hello")).toBe(false)
    expect(hasChangefeed(true)).toBe(false)
  })
})
