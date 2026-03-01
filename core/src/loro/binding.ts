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

  // Get initial value
  const getValue = (): string => {
    if (typeof (loroContainer as LoroText).toString === "function") {
      return (loroContainer as LoroText).toString()
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

    // Update the ref
    if (typeof (loroContainer as LoroText).delete === "function") {
      // TextRef - replace all content
      const textRef = loroContainer as LoroText
      const currentLength = textRef.toString().length
      if (currentLength > 0) {
        textRef.delete(0, currentLength)
      }
      if (newValue.length > 0) {
        textRef.insert(0, newValue)
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

  // Get current boolean value
  const getValue = (): boolean => {
    // LoroCounter has .value property
    if (typeof (loroContainer as { value?: number }).value === "number") {
      return (loroContainer as { value: number }).value > 0
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

    // Update the ref based on its type
    if (
      typeof (loroContainer as { increment?: (n: number) => void })
        .increment === "function"
    ) {
      // Counter - set to 1 (true) or 0 (false)
      const counter = loroContainer as {
        increment: (n: number) => void
        value: number
      }
      const currentValue = counter.value
      if (isChecked && currentValue === 0) {
        counter.increment(1)
      } else if (!isChecked && currentValue > 0) {
        counter.increment(-currentValue)
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

  // Get current numeric value
  const getValue = (): number => {
    // LoroCounter has .value property
    if (typeof (loroContainer as { value?: number }).value === "number") {
      return (loroContainer as { value: number }).value
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

    // Update the ref based on its type
    if (
      typeof (loroContainer as { increment?: (n: number) => void })
        .increment === "function"
    ) {
      // Counter - adjust by difference
      const counter = loroContainer as {
        increment: (n: number) => void
        value: number
      }
      const currentValue = counter.value
      const diff = newValue - currentValue
      if (diff !== 0) {
        counter.increment(diff)
      }
    }
  }

  element.addEventListener("input", handleInput)

  // Clean up event listener on scope dispose
  scope.onDispose(() => {
    element.removeEventListener("input", handleInput)
  })
}
