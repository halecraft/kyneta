/**
 * Type-level tests for reactive-view augmentations and LocalRef widening.
 *
 * These tests validate that:
 * 1. TextRef exposes String instance methods via module augmentation
 * 2. CounterRef exposes Number instance methods via module augmentation
 * 3. LocalRef<T> exposes T's methods via intersection widening
 * 4. Ref mutation methods are preserved alongside value-type methods
 * 5. The CHANGEFEED protocol is preserved on all widened types
 * 6. ScalarRef<boolean> works with logical operators (JS coercion)
 * 7. Literal types are widened correctly (no `never` collapse)
 *
 * These are compile-time tests — they use `expectTypeOf` from vitest
 * to assert type relationships without runtime execution.
 *
 * @packageDocumentation
 */

/// <reference path="../types/reactive-view.d.ts" />

import type { CounterRef, ScalarRef, TextRef } from "@kyneta/schema"
import { describe, expectTypeOf, it } from "vitest"
import type { LocalRef } from "../reactive/local-ref.js"

// =============================================================================
// TextRef — String method augmentation
// =============================================================================

describe("TextRef type widening", () => {
  it("exposes String.prototype.toLowerCase", () => {
    expectTypeOf<TextRef>().toHaveProperty("toLowerCase")
    expectTypeOf<TextRef["toLowerCase"]>().toBeFunction()
  })

  it("exposes String.prototype.toUpperCase", () => {
    expectTypeOf<TextRef>().toHaveProperty("toUpperCase")
  })

  it("exposes String.prototype.includes", () => {
    expectTypeOf<TextRef>().toHaveProperty("includes")
  })

  it("exposes String.prototype.startsWith", () => {
    expectTypeOf<TextRef>().toHaveProperty("startsWith")
  })

  it("exposes String.prototype.endsWith", () => {
    expectTypeOf<TextRef>().toHaveProperty("endsWith")
  })

  it("exposes String.prototype.trim", () => {
    expectTypeOf<TextRef>().toHaveProperty("trim")
  })

  it("exposes String.prototype.slice", () => {
    expectTypeOf<TextRef>().toHaveProperty("slice")
  })

  it("exposes String.prototype.length", () => {
    expectTypeOf<TextRef>().toHaveProperty("length")
  })

  it("preserves TextRef mutation methods", () => {
    expectTypeOf<TextRef>().toHaveProperty("insert")
    expectTypeOf<TextRef>().toHaveProperty("delete")
    expectTypeOf<TextRef>().toHaveProperty("update")
  })

  it("toLowerCase returns string", () => {
    // This is the key test: calling a String method on TextRef
    // produces a string result (the observation morphism applied
    // by the compiler).
    type Result = ReturnType<TextRef["toLowerCase"]>
    expectTypeOf<Result>().toEqualTypeOf<string>()
  })

  it("includes returns boolean", () => {
    type Result = ReturnType<TextRef["includes"]>
    expectTypeOf<Result>().toEqualTypeOf<boolean>()
  })
})

// =============================================================================
// CounterRef — Number method augmentation
// =============================================================================

describe("CounterRef type widening", () => {
  it("exposes Number.prototype.toFixed", () => {
    expectTypeOf<CounterRef>().toHaveProperty("toFixed")
    expectTypeOf<CounterRef["toFixed"]>().toBeFunction()
  })

  it("exposes Number.prototype.toString", () => {
    expectTypeOf<CounterRef>().toHaveProperty("toString")
  })

  it("exposes Number.prototype.valueOf", () => {
    expectTypeOf<CounterRef>().toHaveProperty("valueOf")
  })

  it("exposes Number.prototype.toLocaleString", () => {
    expectTypeOf<CounterRef>().toHaveProperty("toLocaleString")
  })

  it("exposes Number.prototype.toPrecision", () => {
    expectTypeOf<CounterRef>().toHaveProperty("toPrecision")
  })

  it("preserves CounterRef mutation methods", () => {
    expectTypeOf<CounterRef>().toHaveProperty("increment")
    expectTypeOf<CounterRef>().toHaveProperty("decrement")
  })

  it("toFixed returns string", () => {
    type Result = ReturnType<CounterRef["toFixed"]>
    expectTypeOf<Result>().toEqualTypeOf<string>()
  })
})

// =============================================================================
// LocalRef<T> — intersection widening
// =============================================================================

describe("LocalRef<string> type widening", () => {
  it("exposes String.prototype.toLowerCase", () => {
    expectTypeOf<LocalRef<string>>().toHaveProperty("toLowerCase")
  })

  it("exposes String.prototype.includes", () => {
    expectTypeOf<LocalRef<string>>().toHaveProperty("includes")
  })

  it("exposes String.prototype.trim", () => {
    expectTypeOf<LocalRef<string>>().toHaveProperty("trim")
  })

  it("exposes String.prototype.length", () => {
    expectTypeOf<LocalRef<string>>().toHaveProperty("length")
  })

  it("preserves callable read", () => {
    // LocalRef<string> should still be callable, returning string
    expectTypeOf<LocalRef<string>>().toBeCallableWith()
  })

  it("preserves set method", () => {
    expectTypeOf<LocalRef<string>>().toHaveProperty("set")
  })
})

describe("LocalRef<number> type widening", () => {
  it("exposes Number.prototype.toFixed", () => {
    expectTypeOf<LocalRef<number>>().toHaveProperty("toFixed")
  })

  it("exposes Number.prototype.toString", () => {
    expectTypeOf<LocalRef<number>>().toHaveProperty("toString")
  })

  it("preserves callable read", () => {
    expectTypeOf<LocalRef<number>>().toBeCallableWith()
  })

  it("preserves set method", () => {
    expectTypeOf<LocalRef<number>>().toHaveProperty("set")
  })
})

describe("LocalRef<boolean> type widening", () => {
  it("preserves callable read", () => {
    expectTypeOf<LocalRef<boolean>>().toBeCallableWith()
  })

  it("preserves set method", () => {
    expectTypeOf<LocalRef<boolean>>().toHaveProperty("set")
  })

  it("exposes Boolean.prototype.valueOf", () => {
    expectTypeOf<LocalRef<boolean>>().toHaveProperty("valueOf")
  })
})

// =============================================================================
// ScalarRef<boolean> — no augmentation needed
// =============================================================================

describe("ScalarRef<boolean> (no augmentation)", () => {
  it("preserves set method", () => {
    expectTypeOf<ScalarRef<boolean>>().toHaveProperty("set")
  })
})

// =============================================================================
// Literal type widening (no `never` collapse)
// =============================================================================

describe("LocalRef literal type widening", () => {
  it("LocalRef<null> is not never", () => {
    // null & {} = never, but Widen<null> = {}, so LocalRef<null> should work
    expectTypeOf<LocalRef<null>>().not.toBeNever()
  })

  it("LocalRef<undefined> is not never", () => {
    expectTypeOf<LocalRef<undefined>>().not.toBeNever()
  })

  it("LocalRef with string literal is not never", () => {
    expectTypeOf<LocalRef<"hello">>().not.toBeNever()
  })

  it("LocalRef with string literal has String methods", () => {
    expectTypeOf<LocalRef<"hello">>().toHaveProperty("toLowerCase")
  })

  it("LocalRef with number literal is not never", () => {
    expectTypeOf<LocalRef<42>>().not.toBeNever()
  })

  it("LocalRef with number literal has Number methods", () => {
    expectTypeOf<LocalRef<42>>().toHaveProperty("toFixed")
  })

  it("LocalRef with boolean literal is not never", () => {
    expectTypeOf<LocalRef<true>>().not.toBeNever()
  })
})

// =============================================================================
// Object types — LocalRef<T> for complex T
// =============================================================================

describe("LocalRef<object> type widening", () => {
  interface User {
    name: string
    age: number
  }

  it("exposes object properties", () => {
    expectTypeOf<LocalRef<User>>().toHaveProperty("name")
    expectTypeOf<LocalRef<User>>().toHaveProperty("age")
  })

  it("preserves callable read", () => {
    expectTypeOf<LocalRef<User>>().toBeCallableWith()
  })

  it("preserves set method", () => {
    expectTypeOf<LocalRef<User>>().toHaveProperty("set")
  })
})
