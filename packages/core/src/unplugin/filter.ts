/**
 * Shared file filtering for Kyneta build plugins.
 *
 * Extracted from the Vite plugin so that all bundler adapters
 * (via unplugin) share identical include/exclude logic.
 *
 * @packageDocumentation
 */

/**
 * Check if a file should be transformed based on its path.
 *
 * Filtering uses simple substring matching (`.includes()`), not globs.
 * This keeps the logic lightweight and predictable across all bundlers.
 *
 * @param id - The module id / file path provided by the bundler
 * @param extensions - File extensions to transform (e.g. `[".ts", ".tsx"]`)
 * @param include - Optional substring patterns; file must match at least one
 * @param exclude - Optional substring patterns; file is skipped if it matches any (default: `["node_modules"]`)
 */
export function shouldTransform(
  id: string,
  extensions: string[],
  include?: string | string[],
  exclude?: string | string[],
): boolean {
  // Check extension
  const hasValidExtension = extensions.some(ext => id.endsWith(ext))
  if (!hasValidExtension) {
    return false
  }

  // Default excludes
  const excludePatterns = exclude ?? ["node_modules"]
  const excludeList = Array.isArray(excludePatterns)
    ? excludePatterns
    : [excludePatterns]

  // Simple pattern matching
  for (const pattern of excludeList) {
    if (id.includes(pattern)) {
      return false
    }
  }

  // If include patterns specified, file must match one
  if (include) {
    const includeList = Array.isArray(include) ? include : [include]
    const matches = includeList.some(pattern => id.includes(pattern))
    if (!matches) {
      return false
    }
  }

  return true
}