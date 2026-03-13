import { createRollupPlugin } from "unplugin"
import { unpluginFactory, type KynetaPluginOptions } from "../index.js"

export default createRollupPlugin(unpluginFactory)
export type { KynetaPluginOptions }