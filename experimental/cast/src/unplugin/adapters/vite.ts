/**
 * Kyneta Vite plugin — adapter entry point.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import kyneta from "@kyneta/cast/unplugin/vite"
 *
 * export default defineConfig({
 *   plugins: [kyneta()],
 * })
 * ```
 *
 * @packageDocumentation
 */

import { createVitePlugin } from "unplugin"
import { type KynetaPluginOptions, unpluginFactory } from "../index.js"

export default createVitePlugin(unpluginFactory)

export type { KynetaPluginOptions }
