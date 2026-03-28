import { createRolldownPlugin } from "unplugin"
import { type KynetaPluginOptions, unpluginFactory } from "../index.js"

export default createRolldownPlugin(unpluginFactory)
export type { KynetaPluginOptions }
