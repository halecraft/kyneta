/**
 * Two-way binding for form inputs.
 *
 * Bindings connect Loro refs to DOM inputs for bidirectional data flow:
 * - Ref changes update the input value
 * - Input changes update the ref
 *
 * @example
 * ```ts
 * input({ type: "text", value: bind(doc.title) })
 * input({ type: "checkbox", checked: bind(doc.enabled) })
 * ```
 *
 * @packageDocumentation
 */

import { loro } from "@loro-extended/change"
import type { LoroText } from "loro-crdt"
import type { Binding } from "../types.js"
import type { Scope } from "../runtime/scope.js"
import { subscribe } from "../runtime/subscribe.js"

// =============================================================================
// Binding Creation
// =============================================================================

/**
 * Create a two-way binding for a Loro ref.
 *
 * The binding is a marker object that the compiler recognizes.
 * At runtime, the compiler generates code that:
 * 1. Sets the initial value from the ref
 * 2. Subscribes to ref changes to update the input
 * 3. Attaches an event listener to update the ref on input
 *
 * @param ref - A typed ref (TextRef, CounterRef, etc.) or PlainValueRef
 * @returns A binding marker object
 *
 * @example
 * ```ts
 * // Text input binding
 * input({ type: "text", value: bind(doc.title) })
 *
 * // Checkbox binding
 * input({ type: "checkbox", checked: bind(doc.enabled) })
 *
 * // Select binding
 * select({ value: bind(doc.selectedOption) }, () => {
 *   option({ value: "a" }, "Option A")
 *   option({ value: "b" }, "Option B")
 * })
 * ```
 */
export function bind<T>(ref: unknown): Binding<T> {
  return {
    __brand: "kinetic:binding",
    ref: ref as Binding<T>["ref"],
  }
}

/**
 * Check if a value is a binding marker.
 */
export function isBinding(value: unknown): value is Binding<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "__brand" in value &&
    (value as Binding<unknown>).__brand === "kinetic:binding"
  )
}

// =============================================================================
// Container Type Detection
// =============================================================================

/**
 * Check if a Loro container is a LoroText.
 *
 * Uses the presence of `.insert` (a LoroText-specific method) rather than
 * `.toString` (which every object inherits from Object.prototype and is
 * therefore useless as a discriminator).
 */
function isLoroText(
  container: unknown,
): container is LoroText {
  return typeof (container as LoroText).insert === "function"
}

/**
 * Check if a Loro container is a LoroCounter.
 *
 * Requires both `.increment` (the mutation method) and `.value` (the
 * accessor) to be present with correct types. This is stricter than
 * checking `.value` alone, which is common across many types.
 */
function isLoroCounter(
  container: unknown,
): container is { increment: (n: number) => void; value: number } {
  return (
    typeof (container as { increment?: unknown }).increment === "function" &&
    typeof (container as { value?: unknown }).value === "number"
  )
}

// =============================================================================
// Runtime Binding Handlers
// =============================================================================

/**
 * Attach a text value binding to an input element.
 *
 * This sets up:
 * 1. Initial value from the ref
 * 2. Subscription to update input when ref changes
 * 3. Input event listener to update ref when user types
 *
 * This function operates at the `unknown` boundary because compiled code
 * passes refs without static type information. Runtime dispatch via
 * `isLoroText` is used to determine the container type. The `loro()`
 * unwrapper from `@loro-extended/change` validates the input before we
 * reach the dispatch logic.
 *
 * @param element - The input element
 * @param ref - The text ref to bind
 * @param scope - The scope for cleanup
 *
 * @internal - Called by compiled code
 */
export function bindTextValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  ref: unknown,
  scope: Scope,
): void {
  const loroContainer = loro(ref as Parameters<typeof loro>[0])

  // Get initial value — use LoroText-specific .insert check to discriminate
  const getValue = (): string => {
    if (isLoroText(loroContainer)) {
      return loroContainer.toString()
    }
    // For other types, try to get a string representation
    return String(loroContainer)
  }

  // Set initial value
  element.value = getValue()

  // Subscribe to changes from the ref
  subscribe(
    ref,
    () => {
      const newValue = getValue()
      if (element.value !== newValue) {
        element.value = newValue
      }
    },
    scope,
  )

  // Listen for input events
  const handleInput = (event: Event) => {
    const target = event.target as
      | HTMLInputElement
      | HTMLTextAreaElement
      | HTMLSelectElement
    const newValue = target.value

    // Update the ref — use the same discriminator as getValue
    if (isLoroText(loroContainer)) {
      const currentLength = loroContainer.toString().length
      if (currentLength > 0) {
        loroContainer.delete(0, currentLength)
      }
      if (newValue.length > 0) {
        loroContainer.insert(0, newValue)
      }
    }
    // Note: Other ref types would need different handling
  }

  element.addEventListener("input", handleInput)

  // Clean up event listener on scope dispose
  scope.onDispose(() => {
    element.removeEventListener("input", handleInput)
  })
}

/**
 * Attach a checked binding to a checkbox input.
 *
 * This function operates at the `unknown` boundary because compiled code
 * passes refs without static type information. Runtime dispatch via
 * `isLoroCounter` is used to determine the container type. The `loro()`
 * unwrapper from `@loro-extended/change` validates the input before we
 * reach the dispatch logic.
 *
 * @param element - The checkbox input element
 * @param ref - The ref to bind (counter or boolean-like)
 * @param scope - The scope for cleanup
 *
 * @internal - Called by compiled code
 */
export function bindChecked(
  element: HTMLInputElement,
  ref: unknown,
  scope: Scope,
): void {
  const loroContainer = loro(ref as Parameters<typeof loro>[0])

  // Detect container type once, use consistently in both getValue and handler
  const counterMode = isLoroCounter(loroContainer)

  // Get current boolean value
  const getValue = (): boolean => {
    if (counterMode) {
      return loroContainer.value > 0
    }
    // TypedRef has .get() method
    if (typeof (loroContainer as { get?: () => unknown }).get === "function") {
      const val = (loroContainer as { get: () => unknown }).get()
      if (typeof val === "number") {
        return val > 0
      }
      return Boolean(val)
    }
    return Boolean(loroContainer)
  }

  // Set initial value
  element.checked = getValue()

  // Subscribe to changes from the ref
  subscribe(
    ref,
    () => {
      const newValue = getValue()
      if (element.checked !== newValue) {
        element.checked = newValue
      }
    },
    scope,
  )

  // Listen for change events
  const handleChange = (event: Event) => {
    const target = event.target as HTMLInputElement
    const isChecked = target.checked

    // Update the ref — uses the same counterMode flag as getValue
    if (counterMode) {
      const currentValue = loroContainer.value
      if (isChecked && currentValue === 0) {
        loroContainer.increment(1)
      } else if (!isChecked && currentValue > 0) {
        loroContainer.increment(-currentValue)
      }
    }
    // Note: Other ref types would need different handling
  }

  element.addEventListener("change", handleChange)

  // Clean up event listener on scope dispose
  scope.onDispose(() => {
    element.removeEventListener("change", handleChange)
  })
}

/**
 * Attach a numeric value binding to an input element.
 *
 * This function operates at the `unknown` boundary because compiled code
 * passes refs without static type information. Runtime dispatch via
 * `isLoroCounter` is used to determine the container type. The `loro()`
 * unwrapper from `@loro-extended/change` validates the input before we
 * reach the dispatch logic.
 *
 * @param element - The input element (type="number" or type="range")
 * @param ref - The counter ref to bind
 * @param scope - The scope for cleanup
 *
 * @internal - Called by compiled code
 */
export function bindNumericValue(
  element: HTMLInputElement,
  ref: unknown,
  scope: Scope,
): void {
  const loroContainer = loro(ref as Parameters<typeof loro>[0])

  // Detect container type once, use consistently in both getValue and handler
  const counterMode = isLoroCounter(loroContainer)

  // Get current numeric value
  const getValue = (): number => {
    if (counterMode) {
      return loroContainer.value
    }
    // TypedRef has .get() method
    if (typeof (loroContainer as { get?: () => unknown }).get === "function") {
      const val = (loroContainer as { get: () => unknown }).get()
      return Number(val) || 0
    }
    return 0
  }

  // Set initial value
  element.value = String(getValue())

  // Subscribe to changes from the ref
  subscribe(
    ref,
    () => {
      const newValue = String(getValue())
      if (element.value !== newValue) {
        element.value = newValue
      }
    },
    scope,
  )

  // Listen for input events
  const handleInput = (event: Event) => {
    const target = event.target as HTMLInputElement
    const newValue = parseFloat(target.value) || 0

    // Update the ref — uses the same counterMode flag as getValue
    if (counterMode) {
      const currentValue = loroContainer.value
      const diff = newValue - currentValue
      if (diff !== 0) {
        loroContainer.increment(diff)
      }
    }
  }

  element.addEventListener("input", handleInput)

  // Clean up event listener on scope dispose
  scope.onDispose(() => {
    element.removeEventListener("input", handleInput)
  })
}