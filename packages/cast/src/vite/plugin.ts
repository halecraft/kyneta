/**
 * Kyneta Vite Plugin
 *
 * This module re-exports the Vite adapter from the universal unplugin-based
 * plugin. It exists for backward compatibility — consumers who already import
 * from `@kyneta/cast/vite` continue to work without changes.
 *
 * New consumers should prefer `@kyneta/cast/unplugin/vite`.
 *
 * @packageDocumentation
 */

/** @deprecated Use kynetaPlugin instead */
export {
  default,
  default as kynetaPlugin,
  default as kineticPlugin,
  type KynetaPluginOptions,
} from "../unplugin/adapters/vite.js"
/** @deprecated Use KynetaPluginOptions instead */
export type { KynetaPluginOptions as KineticPluginOptions } from "../unplugin/index.js"
