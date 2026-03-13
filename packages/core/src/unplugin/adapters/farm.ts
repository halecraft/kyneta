/**
 * Kyneta Farm plugin — adapter entry point.
 *
 * @example
 * ```ts
 * // farm.config.ts
 * import kyneta from "@kyneta/core/unplugin/farm"
 *
 * export default defineConfig({
 *   plugins: [kyneta()],
 * })
 * ```
 *
 * @packageDocumentation
 */

export { farmPlugin as default, type KynetaPluginOptions } from "../index.js"