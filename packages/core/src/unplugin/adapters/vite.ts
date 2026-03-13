/**
 * Kyneta Vite plugin — adapter entry point.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import kyneta from "@kyneta/core/unplugin/vite"
 *
 * export default defineConfig({
 *   plugins: [kyneta()],
 * })
 * ```
 *
 * @packageDocumentation
 */

export { vitePlugin as default, type KynetaPluginOptions } from "../index.js"