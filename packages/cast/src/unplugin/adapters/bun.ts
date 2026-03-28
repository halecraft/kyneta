/**
 * Kyneta Bun plugin — adapter entry point.
 *
 * @example
 * ```ts
 * // bun.config.ts
 * import kyneta from "@kyneta/cast/unplugin/bun"
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
import { type KynetaPluginOptions, unpluginFactory } from "../index.js"

export default createBunPlugin(unpluginFactory)
export type { KynetaPluginOptions }
