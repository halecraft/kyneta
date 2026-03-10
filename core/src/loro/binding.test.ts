/**
 * Unit tests for two-way bindings.
 *
 * These tests verify that the binding runtime functions correctly
 * sync values between Loro refs and DOM inputs.
 */

import { createTypedDoc, loro, Shape } from "@loro-extended/change"
import { JSDOM } from "jsdom"
import { beforeEach, describe, expect, it } from "vitest"
import {
  bindChecked,
  bindNumericValue,
  bindTextValue,
  bind,
  isBinding,
} from "./binding.js"
import { resetScopeIdCounter, Scope } from "../runtime/scope.js"
import {
  activeSubscriptions,
  resetSubscriptionIdCounter,
} from "../runtime/subscribe.js"

// Set up DOM globals for testing
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>")
global.document = dom.window.document
global.Node = dom.window.Node
global.Element = dom.window.Element
global.HTMLInputElement = dom.window.HTMLInputElement
global.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
global.HTMLSelectElement = dom.window.HTMLSelectElement
global.Event = dom.window.Event

// =============================================================================
// bind() and isBinding() Tests
// =============================================================================

describe("bind()", () => {
  it("should create a binding marker object", () => {
    const mockRef = { get: () => "test" }
    const binding = bind(mockRef)

    expect(binding.__brand).toBe("kinetic:binding")
    expect(binding.ref).toBe(mockRef)
  })

  it("should work with any ref type", () => {
    const schema = Shape.doc({
      title: Shape.text(),
    })
    const doc = createTypedDoc(schema)

    const binding = bind(doc.title)

    expect(binding.__brand).toBe("kinetic:binding")
    expect(binding.ref).toBe(doc.title)
  })
})

describe("isBinding()", () => {
  it("should return true for binding objects", () => {
    const binding = bind({ get: () => "test" })
    expect(isBinding(binding)).toBe(true)
  })

  it("should return false for non-binding objects", () => {
    expect(isBinding(null)).toBe(false)
    expect(isBinding(undefined)).toBe(false)
    expect(isBinding("string")).toBe(false)
    expect(isBinding(123)).toBe(false)
    expect(isBinding({ __brand: "other" })).toBe(false)
    expect(isBinding({ ref: {} })).toBe(false)
  })
})

// =============================================================================
// bindTextValue Tests
// =============================================================================

describe("bindTextValue", () => {
  beforeEach(() => {
    resetSubscriptionIdCounter()
    resetScopeIdCounter()
  })

  it("should set initial value from text ref", () => {
    const schema = Shape.doc({
      title: Shape.text(),
    })
    const doc = createTypedDoc(schema)
    doc.title.insert(0, "Hello")
    loro(doc).commit()

    const input = document.createElement("input")
    const scope = new Scope("test")

    bindTextValue(input, doc.title, scope)

    expect(input.value).toBe("Hello")

    scope.dispose()
  })

  it("should update input when ref changes", () => {
    const schema = Shape.doc({
      title: Shape.text(),
    })
    const doc = createTypedDoc(schema)
    doc.title.insert(0, "Hello")
    loro(doc).commit()

    const input = document.createElement("input")
    const scope = new Scope("test")

    bindTextValue(input, doc.title, scope)

    expect(input.value).toBe("Hello")

    // Update the ref
    doc.title.delete(0, 5)
    doc.title.insert(0, "World")
    loro(doc).commit()

    expect(input.value).toBe("World")

    scope.dispose()
  })

  it("should update ref when input changes", () => {
    const schema = Shape.doc({
      title: Shape.text(),
    })
    const doc = createTypedDoc(schema)
    loro(doc).commit()

    const input = document.createElement("input")
    const scope = new Scope("test")

    bindTextValue(input, doc.title, scope)

    // Simulate user input
    input.value = "User typed"
    input.dispatchEvent(new Event("input"))

    expect(doc.title.toString()).toBe("User typed")

    scope.dispose()
  })

  it("should clean up event listener on scope dispose", () => {
    const schema = Shape.doc({
      title: Shape.text(),
    })
    const doc = createTypedDoc(schema)
    loro(doc).commit()

    const input = document.createElement("input")
    const scope = new Scope("test")

    bindTextValue(input, doc.title, scope)

    // Dispose the scope
    scope.dispose()

    // Input changes should not affect the ref anymore
    const originalValue = doc.title.toString()
    input.value = "After dispose"
    input.dispatchEvent(new Event("input"))

    // The ref should not have changed
    expect(doc.title.toString()).toBe(originalValue)
  })

  it("should work with textarea elements", () => {
    const schema = Shape.doc({
      content: Shape.text(),
    })
    const doc = createTypedDoc(schema)
    doc.content.insert(0, "Initial content")
    loro(doc).commit()

    const textarea = document.createElement("textarea")
    const scope = new Scope("test")

    bindTextValue(textarea, doc.content, scope)

    expect(textarea.value).toBe("Initial content")

    // Update via input
    textarea.value = "New content"
    textarea.dispatchEvent(new Event("input"))

    expect(doc.content.toString()).toBe("New content")

    scope.dispose()
  })

  it("should handle empty initial value", () => {
    const schema = Shape.doc({
      title: Shape.text(),
    })
    const doc = createTypedDoc(schema)
    loro(doc).commit()

    const input = document.createElement("input")
    const scope = new Scope("test")

    bindTextValue(input, doc.title, scope)

    expect(input.value).toBe("")

    scope.dispose()
  })
})

// =============================================================================
// bindChecked Tests
// =============================================================================

describe("bindChecked", () => {
  beforeEach(() => {
    resetSubscriptionIdCounter()
    resetScopeIdCounter()
  })

  it("should set initial checked state from counter (> 0 = true)", () => {
    const schema = Shape.doc({
      enabled: Shape.counter(),
    })
    const doc = createTypedDoc(schema)
    doc.enabled.increment(1)
    loro(doc).commit()

    const checkbox = document.createElement("input")
    checkbox.type = "checkbox"
    const scope = new Scope("test")

    bindChecked(checkbox, doc.enabled, scope)

    expect(checkbox.checked).toBe(true)

    scope.dispose()
  })

  it("should set initial unchecked state from counter (0 = false)", () => {
    const schema = Shape.doc({
      enabled: Shape.counter(),
    })
    const doc = createTypedDoc(schema)
    // Default is 0
    loro(doc).commit()

    const checkbox = document.createElement("input")
    checkbox.type = "checkbox"
    const scope = new Scope("test")

    bindChecked(checkbox, doc.enabled, scope)

    expect(checkbox.checked).toBe(false)

    scope.dispose()
  })

  it("should update checkbox when counter changes", () => {
    const schema = Shape.doc({
      enabled: Shape.counter(),
    })
    const doc = createTypedDoc(schema)
    loro(doc).commit()

    const checkbox = document.createElement("input")
    checkbox.type = "checkbox"
    const scope = new Scope("test")

    bindChecked(checkbox, doc.enabled, scope)

    expect(checkbox.checked).toBe(false)

    // Increment counter to make it true
    doc.enabled.increment(1)
    loro(doc).commit()

    expect(checkbox.checked).toBe(true)

    // Decrement back to 0
    doc.enabled.increment(-1)
    loro(doc).commit()

    expect(checkbox.checked).toBe(false)

    scope.dispose()
  })

  it("should update counter when checkbox is toggled", () => {
    const schema = Shape.doc({
      enabled: Shape.counter(),
    })
    const doc = createTypedDoc(schema)
    loro(doc).commit()

    const checkbox = document.createElement("input")
    checkbox.type = "checkbox"
    const scope = new Scope("test")

    bindChecked(checkbox, doc.enabled, scope)

    // Toggle on
    checkbox.checked = true
    checkbox.dispatchEvent(new Event("change"))

    expect(doc.enabled.get()).toBe(1)

    // Toggle off
    checkbox.checked = false
    checkbox.dispatchEvent(new Event("change"))

    expect(doc.enabled.get()).toBe(0)

    scope.dispose()
  })

  it("should clean up event listener on scope dispose", () => {
    const schema = Shape.doc({
      enabled: Shape.counter(),
    })
    const doc = createTypedDoc(schema)
    loro(doc).commit()

    const checkbox = document.createElement("input")
    checkbox.type = "checkbox"
    const scope = new Scope("test")

    bindChecked(checkbox, doc.enabled, scope)

    scope.dispose()

    // Checkbox changes should not affect the counter anymore
    checkbox.checked = true
    checkbox.dispatchEvent(new Event("change"))

    expect(doc.enabled.get()).toBe(0)
  })
})

// =============================================================================
// bindNumericValue Tests
// =============================================================================

describe("bindNumericValue", () => {
  beforeEach(() => {
    resetSubscriptionIdCounter()
    resetScopeIdCounter()
  })

  it("should set initial value from counter", () => {
    const schema = Shape.doc({
      count: Shape.counter(),
    })
    const doc = createTypedDoc(schema)
    doc.count.increment(42)
    loro(doc).commit()

    const input = document.createElement("input")
    input.type = "number"
    const scope = new Scope("test")

    bindNumericValue(input, doc.count, scope)

    expect(input.value).toBe("42")

    scope.dispose()
  })

  it("should update input when counter changes", () => {
    const schema = Shape.doc({
      count: Shape.counter(),
    })
    const doc = createTypedDoc(schema)
    doc.count.increment(10)
    loro(doc).commit()

    const input = document.createElement("input")
    input.type = "number"
    const scope = new Scope("test")

    bindNumericValue(input, doc.count, scope)

    expect(input.value).toBe("10")

    doc.count.increment(5)
    loro(doc).commit()

    expect(input.value).toBe("15")

    scope.dispose()
  })

  it("should update counter when input changes", () => {
    const schema = Shape.doc({
      count: Shape.counter(),
    })
    const doc = createTypedDoc(schema)
    doc.count.increment(10)
    loro(doc).commit()

    const input = document.createElement("input")
    input.type = "number"
    const scope = new Scope("test")

    bindNumericValue(input, doc.count, scope)

    // Simulate user changing the value
    input.value = "25"
    input.dispatchEvent(new Event("input"))

    expect(doc.count.get()).toBe(25)

    scope.dispose()
  })

  it("should work with range input", () => {
    const schema = Shape.doc({
      volume: Shape.counter(),
    })
    const doc = createTypedDoc(schema)
    doc.volume.increment(50)
    loro(doc).commit()

    const input = document.createElement("input")
    input.type = "range"
    input.min = "0"
    input.max = "100"
    const scope = new Scope("test")

    bindNumericValue(input, doc.volume, scope)

    expect(input.value).toBe("50")

    // Simulate slider change
    input.value = "75"
    input.dispatchEvent(new Event("input"))

    expect(doc.volume.get()).toBe(75)

    scope.dispose()
  })

  it("should handle zero initial value", () => {
    const schema = Shape.doc({
      count: Shape.counter(),
    })
    const doc = createTypedDoc(schema)
    loro(doc).commit()

    const input = document.createElement("input")
    input.type = "number"
    const scope = new Scope("test")

    bindNumericValue(input, doc.count, scope)

    expect(input.value).toBe("0")

    scope.dispose()
  })

  it("should handle negative values", () => {
    const schema = Shape.doc({
      count: Shape.counter(),
    })
    const doc = createTypedDoc(schema)
    doc.count.increment(-5)
    loro(doc).commit()

    const input = document.createElement("input")
    input.type = "number"
    const scope = new Scope("test")

    bindNumericValue(input, doc.count, scope)

    expect(input.value).toBe("-5")

    scope.dispose()
  })

  it("should clean up event listener on scope dispose", () => {
    const schema = Shape.doc({
      count: Shape.counter(),
    })
    const doc = createTypedDoc(schema)
    doc.count.increment(10)
    loro(doc).commit()

    const input = document.createElement("input")
    input.type = "number"
    const scope = new Scope("test")

    bindNumericValue(input, doc.count, scope)

    scope.dispose()

    // Input changes should not affect the counter anymore
    input.value = "999"
    input.dispatchEvent(new Event("input"))

    expect(doc.count.get()).toBe(10)
  })
})

// =============================================================================
// Negative Tests — Non-Reactive Values
// =============================================================================

describe("binding functions reject non-reactive values", () => {
  beforeEach(() => {
    resetSubscriptionIdCounter()
    resetScopeIdCounter()
    activeSubscriptions.clear()
  })

  it("bindTextValue throws for a plain string", () => {
    const input = document.createElement("input")
    const scope = new Scope("test")

    expect(() => {
      bindTextValue(input, "not a ref", scope)
    }).toThrow()

    scope.dispose()
  })

  it("bindTextValue throws for a plain object", () => {
    const input = document.createElement("input")
    const scope = new Scope("test")

    expect(() => {
      bindTextValue(input, { value: "hello" }, scope)
    }).toThrow()

    scope.dispose()
  })

  it("bindChecked throws for a plain number", () => {
    const checkbox = document.createElement("input")
    checkbox.type = "checkbox"
    const scope = new Scope("test")

    expect(() => {
      bindChecked(checkbox, 42, scope)
    }).toThrow()

    scope.dispose()
  })

  it("bindChecked throws for a plain boolean", () => {
    const checkbox = document.createElement("input")
    checkbox.type = "checkbox"
    const scope = new Scope("test")

    expect(() => {
      bindChecked(checkbox, true, scope)
    }).toThrow()

    scope.dispose()
  })

  it("bindNumericValue throws for a plain number", () => {
    const input = document.createElement("input")
    input.type = "number"
    const scope = new Scope("test")

    expect(() => {
      bindNumericValue(input, 99, scope)
    }).toThrow()

    scope.dispose()
  })

  it("bindNumericValue throws for null", () => {
    const input = document.createElement("input")
    input.type = "number"
    const scope = new Scope("test")

    expect(() => {
      bindNumericValue(input, null, scope)
    }).toThrow()

    scope.dispose()
  })
})
