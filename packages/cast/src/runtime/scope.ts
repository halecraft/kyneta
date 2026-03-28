/**
 * Scope - Ownership tracking for subscriptions and nested regions.
 *
 * Each reactive region (list, conditional) creates a Scope that owns its subscriptions.
 * When a region is destroyed (item deleted, condition becomes false), its scope disposes
 * all nested subscriptions automatically. This prevents memory leaks without manual cleanup.
 *
 * Performance optimizations:
 * - Lazy allocation: cleanups array and children set are not allocated until first use
 * - Numeric IDs: uses numbers instead of strings to avoid allocation in tight loops
 *
 * @example
 * ```ts
 * const scope = new Scope()
 *
 * // Register cleanup functions
 * scope.onDispose(() => console.log("cleanup 1"))
 * scope.onDispose(() => console.log("cleanup 2"))
 *
 * // Create nested scopes for nested regions
 * const child = scope.createChild()
 * child.onDispose(() => console.log("child cleanup"))
 *
 * // Disposing parent cascades to children
 * scope.dispose() // logs: "child cleanup", "cleanup 2", "cleanup 1"
 * ```
 */

import { ScopeDisposedError } from "../errors.js"
import type { ScopeInterface } from "../types.js"

let scopeIdCounter = 0

/**
 * Generate a unique scope ID.
 */
function generateScopeId(): number {
  return ++scopeIdCounter
}

/**
 * Reset the scope ID counter (for testing).
 */
export function resetScopeIdCounter(): void {
  scopeIdCounter = 0
}

/**
 * Scope for tracking subscriptions and nested regions.
 *
 * Scopes form a tree structure where disposing a parent automatically
 * disposes all children. This matches the DOM tree structure and ensures
 * cleanup cascades correctly.
 */
export class Scope implements ScopeInterface {
  /** Unique identifier for this scope */
  readonly id: number

  /** Whether this scope has been disposed */
  private _disposed = false

  /** Cleanup functions to call on dispose (lazy - null until first use) */
  private cleanups: Array<() => void> | null = null

  /** Child scopes (for cascading dispose) (lazy - null until first use) */
  private children: Set<Scope> | null = null

  /** Parent scope (for removal on dispose) */
  private parent: Scope | null = null

  constructor(id?: number) {
    this.id = id ?? generateScopeId()
  }

  /**
   * Whether this scope has been disposed.
   */
  get disposed(): boolean {
    return this._disposed
  }

  /**
   * Add a cleanup function to be called on dispose.
   * Cleanups are called in reverse order (LIFO).
   *
   * @param cleanup - Function to call on dispose
   * @throws ScopeDisposedError if the scope is already disposed
   */
  onDispose(cleanup: () => void): void {
    if (this._disposed) {
      throw new ScopeDisposedError(this.id)
    }
    // Lazy allocation: create array only when first cleanup is added
    if (this.cleanups === null) {
      this.cleanups = []
    }
    this.cleanups.push(cleanup)
  }

  /**
   * Create a child scope owned by this scope.
   * The child will be disposed when this scope is disposed.
   *
   * @returns A new child scope
   * @throws ScopeDisposedError if the scope is already disposed
   */
  createChild(): Scope {
    if (this._disposed) {
      throw new ScopeDisposedError(this.id)
    }
    const child = new Scope()
    child.parent = this
    // Lazy allocation: create set only when first child is added
    if (this.children === null) {
      this.children = new Set()
    }
    this.children.add(child)
    return child
  }

  /**
   * Dispose this scope and all children.
   * Calls all cleanup functions in reverse order.
   * Child scopes are disposed first (depth-first).
   *
   * Calling dispose multiple times is safe (no-op after first).
   */
  dispose(): void {
    if (this._disposed) {
      return
    }
    this._disposed = true

    // Dispose children first (depth-first)
    if (this.children !== null) {
      for (const child of this.children) {
        child.dispose()
      }
      this.children.clear()
    }

    // Call cleanups in reverse order (LIFO)
    if (this.cleanups !== null) {
      while (this.cleanups.length > 0) {
        const cleanup = this.cleanups.pop()
        try {
          cleanup?.()
        } catch (e) {
          // Log but don't throw - we want to continue cleanup
          console.error(`Error in scope cleanup for scope ${this.id}:`, e)
        }
      }
    }

    // Remove from parent's children set
    if (this.parent) {
      this.parent.children?.delete(this)
      this.parent = null
    }
  }

  /**
   * Get the number of active subscriptions (cleanups) in this scope.
   * Does not include child scopes.
   * @internal - For testing
   */
  get cleanupCount(): number {
    return this.cleanups?.length ?? 0
  }

  /**
   * Get the number of child scopes.
   * @internal - For testing
   */
  get childCount(): number {
    return this.children?.size ?? 0
  }

  /**
   * Get total cleanup count including all descendants.
   * @internal - For testing
   */
  get totalCleanupCount(): number {
    let total = this.cleanups?.length ?? 0
    if (this.children !== null) {
      for (const child of this.children) {
        total += child.totalCleanupCount
      }
    }
    return total
  }

  /**
   * Check if the cleanups array has been allocated.
   * @internal - For testing lazy allocation
   */
  get hasAllocatedCleanups(): boolean {
    return this.cleanups !== null
  }

  /**
   * Check if the children set has been allocated.
   * @internal - For testing lazy allocation
   */
  get hasAllocatedChildren(): boolean {
    return this.children !== null
  }
}

/**
 * The root scope for the entire mounted application.
 * Created by mount() and disposed by the returned dispose function.
 */
export let rootScope: Scope | null = null

/**
 * Set the root scope.
 * Called by mount().
 */
export function setRootScope(scope: Scope | null): void {
  rootScope = scope
}

/**
 * Get the current root scope.
 * @throws Error if no root scope exists (not mounted)
 */
export function getRootScope(): Scope {
  if (!rootScope) {
    throw new Error(
      "No root scope. Did you forget to call mount()? " +
        "Kyneta code must run inside a mounted application.",
    )
  }
  return rootScope
}
