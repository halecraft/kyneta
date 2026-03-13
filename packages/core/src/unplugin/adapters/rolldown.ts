import { createRolldownPlugin } from "unplugin"
import { unpluginFactory, type KynetaPluginOptions } from "../index.js"

export default createRolldownPlugin(unpluginFactory)
export type { KynetaPluginOptions }