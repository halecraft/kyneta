import { createRollupPlugin } from "unplugin"
import { type KynetaPluginOptions, unpluginFactory } from "../index.js"

export default createRollupPlugin(unpluginFactory)
export type { KynetaPluginOptions }
