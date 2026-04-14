/**
 * Kyneta esbuild plugin — adapter entry point.
 *
 * @example
 * ```ts
 * import kyneta from "@kyneta/cast/unplugin/esbuild"
 *
 * await build({
 *   plugins: [kyneta()],
 * })
 * ```
 *
 * @packageDocumentation
 */

import { createEsbuildPlugin } from "unplugin"
import { type KynetaPluginOptions, unpluginFactory } from "../index.js"

export default createEsbuildPlugin(unpluginFactory)
export type { KynetaPluginOptions }
