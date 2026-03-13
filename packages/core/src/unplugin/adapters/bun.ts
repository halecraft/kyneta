/**
 * Kyneta Bun plugin — adapter entry point.
 *
 * @example
 * ```ts
 * // bun.config.ts
 * import kyneta from "@kyneta/core/unplugin/bun"
 *
 * await Bun.build({
 *   entrypoints: ["./src/index.ts"],
 *   outdir: "./dist",
 *   plugins: [kyneta()],
 * })
 * ```
 *
 * @packageDocumentation
 */

import { createBunPlugin } from "unplugin"
import { unpluginFactory, type KynetaPluginOptions } from "../index.js"

export default createBunPlugin(unpluginFactory)
export type { KynetaPluginOptions }