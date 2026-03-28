/**
 * Counting DOM Proxy for O(k) verification tests.
 *
 * This module provides a DOM proxy that counts DOM operations,
 * allowing tests to verify that updates are O(k) where k is the
 * number of operations, not O(n) where n is the list length.
 *
 * @example
 * ```ts
 * const { container, counts } = createCountingContainer()
 *
 * // Perform operations...
 * container.appendChild(document.createElement("li"))
 * container.insertBefore(document.createElement("li"), container.firstChild)
 * container.removeChild(container.lastChild)
 *
 * // Verify O(k) behavior
 * expect(counts.appendChild).toBe(1)
 * expect(counts.insertBefore).toBe(1)
 * expect(counts.removeChild).toBe(1)
 * ```
 *
 * @packageDocumentation
 */

/**
 * Counts of DOM operations.
 */
export interface DOMOperationCounts {
  /** Number of appendChild calls */
  appendChild: number
  /** Number of insertBefore calls */
  insertBefore: number
  /** Number of removeChild calls */
  removeChild: number
  /** Number of replaceChild calls */
  replaceChild: number
  /** Number of textContent sets */
  textContentSet: number
  /** Number of setAttribute calls */
  setAttribute: number
  /** Number of removeAttribute calls */
  removeAttribute: number
}

/**
 * Create a fresh counts object with all zeros.
 */
export function createCounts(): DOMOperationCounts {
  return {
    appendChild: 0,
    insertBefore: 0,
    removeChild: 0,
    replaceChild: 0,
    textContentSet: 0,
    setAttribute: 0,
    removeAttribute: 0,
  }
}

/**
 * Result of creating a counting container.
 */
export interface CountingContainerResult {
  /** The container element with counting proxies */
  container: Element
  /** The operation counts */
  counts: DOMOperationCounts
  /** Reset all counts to zero */
  reset: () => void
}

/**
 * Create a DOM container that counts operations.
 *
 * Returns a real DOM element with proxied methods that increment counters.
 * The element behaves normally - it just also counts operations.
 *
 * @param tagName - The tag name for the container (default: "div")
 * @returns The counting container, counts object, and reset function
 *
 * @example
 * ```ts
 * const { container, counts, reset } = createCountingContainer()
 *
 * // Insert 1000 items initially
 * for (let i = 0; i < 1000; i++) {
 *   container.appendChild(document.createElement("li"))
 * }
 * reset() // Reset counts after initial setup
 *
 * // Now insert one more item
 * container.insertBefore(
 *   document.createElement("li"),
 *   container.children[500]
 * )
 *
 * // Should be O(1), not O(n)
 * expect(counts.insertBefore).toBe(1)
 * expect(counts.appendChild).toBe(0)
 * expect(counts.removeChild).toBe(0)
 * ```
 */
export function createCountingContainer(
  tagName: string = "div",
): CountingContainerResult {
  const counts = createCounts()
  const container = document.createElement(tagName)

  // Store original methods
  const originalAppendChild = container.appendChild.bind(container)
  const originalInsertBefore = container.insertBefore.bind(container)
  const originalRemoveChild = container.removeChild.bind(container)
  const originalReplaceChild = container.replaceChild.bind(container)
  const originalSetAttribute = container.setAttribute.bind(container)
  const originalRemoveAttribute = container.removeAttribute.bind(container)

  // Override methods to count
  container.appendChild = <T extends Node>(node: T): T => {
    counts.appendChild++
    return originalAppendChild(node)
  }

  container.insertBefore = <T extends Node>(node: T, child: Node | null): T => {
    counts.insertBefore++
    return originalInsertBefore(node, child)
  }

  container.removeChild = <T extends Node>(child: T): T => {
    counts.removeChild++
    return originalRemoveChild(child)
  }

  container.replaceChild = <T extends Node>(node: Node, child: T): T => {
    counts.replaceChild++
    return originalReplaceChild(node, child)
  }

  container.setAttribute = (name: string, value: string): void => {
    counts.setAttribute++
    originalSetAttribute(name, value)
  }

  container.removeAttribute = (name: string): void => {
    counts.removeAttribute++
    originalRemoveAttribute(name)
  }

  // Track textContent sets via a property descriptor
  let _textContent = ""
  Object.defineProperty(container, "textContent", {
    get() {
      return _textContent
    },
    set(value: string) {
      counts.textContentSet++
      _textContent = value
      // Also clear children (like real textContent does)
      while (container.firstChild) {
        container.removeChild(container.firstChild)
      }
      if (value) {
        container.appendChild(document.createTextNode(value))
      }
    },
    configurable: true,
  })

  const reset = () => {
    counts.appendChild = 0
    counts.insertBefore = 0
    counts.removeChild = 0
    counts.replaceChild = 0
    counts.textContentSet = 0
    counts.setAttribute = 0
    counts.removeAttribute = 0
  }

  return { container, counts, reset }
}

/**
 * Assert that an operation was called exactly n times.
 *
 * @param counts - The counts object
 * @param operation - The operation to check
 * @param expected - The expected count
 * @throws Error if the count doesn't match
 */
export function assertOperationCount(
  counts: DOMOperationCounts,
  operation: keyof DOMOperationCounts,
  expected: number,
): void {
  const actual = counts[operation]
  if (actual !== expected) {
    throw new Error(
      `Expected ${operation} to be called ${expected} times, but was called ${actual} times`,
    )
  }
}

/**
 * Assert that total DOM mutations are at most n.
 *
 * This is useful for verifying O(k) behavior where k is the number
 * of logical operations, not the list size.
 *
 * @param counts - The counts object
 * @param maxMutations - Maximum allowed total mutations
 * @throws Error if total mutations exceed the limit
 */
export function assertMaxMutations(
  counts: DOMOperationCounts,
  maxMutations: number,
): void {
  const total =
    counts.appendChild +
    counts.insertBefore +
    counts.removeChild +
    counts.replaceChild

  if (total > maxMutations) {
    throw new Error(
      `Expected at most ${maxMutations} DOM mutations, but got ${total}: ` +
        `appendChild=${counts.appendChild}, insertBefore=${counts.insertBefore}, ` +
        `removeChild=${counts.removeChild}, replaceChild=${counts.replaceChild}`,
    )
  }
}

/**
 * Get total mutation count.
 *
 * @param counts - The counts object
 * @returns Total number of DOM tree mutations (not attribute changes)
 */
export function getTotalMutations(counts: DOMOperationCounts): number {
  return (
    counts.appendChild +
    counts.insertBefore +
    counts.removeChild +
    counts.replaceChild
  )
}
