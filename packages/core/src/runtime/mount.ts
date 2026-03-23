/**
 * Mount and dispose functions for Kyneta applications.
 *
 * mount() renders a Kyneta element to the DOM and returns a dispose function.
 * All subscriptions and cleanup are managed automatically via scopes.
 *
 * @packageDocumentation
 */

import { InvalidMountTargetError } from "../errors.js"
import type { MountOptions, MountResult, ScopeInterface } from "../types.js"
import { Scope, setRootScope } from "./scope.js"

/**
 * Mount a Kyneta element to a DOM container.
 *
 * Creates a root scope and passes it to the element factory. All reactive
 * subscriptions registered via the scope are disposed when the returned
 * `dispose()` function is called.
 *
 * @param element - A scope-accepting factory that returns a DOM node.
 *   This is the `Element` type (`(scope: ScopeInterface) => Node`), which
 *   is what the Kyneta compiler produces from builder calls like
 *   `div(() => { h1("Hello") })`.
 * @param container - The DOM element to mount into
 * @param options - Mount options (e.g., hydration mode)
 * @returns MountResult with the root node and dispose function
 *
 * @example
 * ```ts
 * import { div, h1, mount } from "@kyneta/core"
 *
 * const app = div(() => {
 *   h1("Hello, World!")
 * })
 *
 * const { dispose } = mount(app, document.getElementById("root")!)
 *
 * // Later, to clean up:
 * dispose()
 * ```
 */
export function mount(
  element: (scope: ScopeInterface) => Node,
  container: Element,
  options: MountOptions = {},
): MountResult {
  // Validate container
  if (!container || !(container instanceof Element)) {
    throw new InvalidMountTargetError(
      "mount() requires a valid DOM Element as the container. " +
        `Received: ${container}`,
    )
  }

  // Create the root scope
  const rootScope = new Scope()
  setRootScope(rootScope)

  let node: Node

  if (options.hydrate) {
    // Hydration mode: adopt existing DOM
    // For now, just get the first child - full hydration comes in Phase 10
    const existingNode = container.firstChild
    if (!existingNode) {
      throw new InvalidMountTargetError(
        "Hydration mode requires existing DOM content, but container is empty.",
      )
    }
    node = existingNode

    // TODO: Phase 10 - Walk and adopt existing nodes, attach subscriptions
    // For now, we just acknowledge the existing node
  } else {
    // Normal mode: render fresh
    // Clear existing content
    container.textContent = ""

    // Create the element, passing the root scope
    node = element(rootScope)

    // Append to container
    container.appendChild(node)
  }

  // Return the result with dispose function
  return {
    node,
    dispose: () => {
      // Dispose the root scope (cascades to all children)
      rootScope.dispose()
      setRootScope(null)

      // Remove from DOM if still attached
      if (node.parentNode === container) {
        container.removeChild(node)
      }
    },
  }
}

/**
 * Get the current root scope for the mounted application.
 *
 * This is primarily for internal use by compiled code.
 * User code should not need to access the root scope directly.
 *
 * @returns The root scope, or null if not mounted
 */
export { getRootScope, rootScope } from "./scope.js"
