// utils — shared utilities for @kyneta/exchange.

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a principal is a non-empty string.
 *
 * @throws If principal is empty or not a string.
 */
export function validatePrincipal(principal: string): void {
  if (typeof principal !== "string" || principal.length === 0) {
    throw new Error(
      `Invalid principal: expected a non-empty string, got ${JSON.stringify(principal)}`,
    )
  }
}
