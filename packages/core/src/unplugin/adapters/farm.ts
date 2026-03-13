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

import type { JsPlugin } from "@farmfe/core"
import { createFarmPlugin } from "unplugin"
import { unpluginFactory, type KynetaPluginOptions } from "../index.js"

const farmPlugin: (options?: KynetaPluginOptions) => JsPlugin =
  createFarmPlugin(unpluginFactory)

export default farmPlugin

export type { KynetaPluginOptions }