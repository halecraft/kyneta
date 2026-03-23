/**
 * Kyneta Universal Build Plugin (unplugin)
 *
 * A single plugin definition that works across Vite, Bun, Rollup,
 * Rolldown, esbuild, Farm, and webpack — all via unplugin.
 *
 * The Kyneta compiler must run **before** TypeScript type-stripping
 * because it inspects type annotations to detect reactive refs via
 * the `CHANGEFEED` protocol. This is achieved via `enforce: "pre"`:
 *
 * | Bundler | Why it works |
 * |---------|--------------|
 * | Vite    | `enforce: "pre"` is native |
 * | Farm    | unplugin maps it to `priority: 102` |
 * | Bun     | `onLoad` intercepts raw source before parsing |
 *
 * @packageDocumentation
 */

import { hasBuilderCalls } from "@kyneta/compiler"
import type { UnpluginFactory } from "unplugin"
import { createUnplugin } from "unplugin"
import { shouldTransform } from "./filter.js"
import { transformKynetaSource } from "./transform.js"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for the Kyneta build plugin.
 */
export interface KynetaPluginOptions {
  /**
   * File extensions to transform.
   * @default [".ts", ".tsx"]
   */
  extensions?: string[]

  /**
   * Patterns to include (substring match).
   * If specified, only files matching at least one pattern are transformed.
   */
  include?: string | string[]

  /**
   * Patterns to exclude (substring match).
   * @default ["node_modules"]
   */
  exclude?: string | string[]

  /**
   * Compile target.
   *
   * - `"dom"` — client-side rendering (default)
   * - `"html"` — server-side rendering / SSR
   *
   * When using the Vite adapter the target is auto-detected from
   * `transformOptions.ssr` unless explicitly set here.
   */
  target?: "dom" | "html"

  /**
   * Enable debug logging.
   * @default false
   */
  debug?: boolean
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * The unplugin factory that produces a universal Kyneta plugin.
 */
export const unpluginFactory: UnpluginFactory<
  KynetaPluginOptions | undefined
> = options => {
  const extensions = options?.extensions ?? [".ts", ".tsx"]
  const debug = options?.debug ?? false
  const resolvedTarget = options?.target ?? "dom"
  const include = options?.include
  const exclude = options?.exclude

  return {
    name: "kyneta",
    enforce: "pre",

    // ------------------------------------------------------------------
    // Universal transform hook (used by all bundlers except Vite, which
    // overrides via the `vite:` escape hatch below).
    // ------------------------------------------------------------------
    transform: {
      filter: {
        id: /\.tsx?$/,
      },
      handler(code, id) {
        if (!shouldTransform(id, extensions, include, exclude)) {
          return null
        }
        return transformKynetaSource(code, id, resolvedTarget, debug)
      },
    },

    // ------------------------------------------------------------------
    // Vite-specific overrides
    // ------------------------------------------------------------------
    vite: {
      // Capture dev/prod mode for debug logging
      configResolved(config) {
        if (debug) {
          const isDev = config.command === "serve"
          console.log(
            `[kyneta] Running in ${isDev ? "development" : "production"} mode`,
          )
        }
      },

      // Override transform to capture Vite's per-request SSR flag
      transform(code, id, transformOptions) {
        if (!shouldTransform(id, extensions, include, exclude)) {
          return null
        }
        const target =
          options?.target ?? (transformOptions?.ssr ? "html" : "dom")
        return transformKynetaSource(code, id, target, debug)
      },

      // HMR support — Vite only
      handleHotUpdate(ctx) {
        const { file, modules } = ctx

        if (!shouldTransform(file, extensions, include, exclude)) {
          return
        }

        const checkForBuilders = async () => {
          const code = await ctx.read()
          if (hasBuilderCalls(code)) {
            if (debug) {
              console.log(`[kyneta] HMR update for ${file}`)
            }
            return modules
          }
          return undefined
        }

        return checkForBuilders()
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Plugin instances
// ---------------------------------------------------------------------------

/**
 * The universal unplugin instance.
 *
 * Most consumers should use the bundler-specific exports below instead.
 */
export const unplugin = /* #__PURE__ */ createUnplugin(unpluginFactory)
