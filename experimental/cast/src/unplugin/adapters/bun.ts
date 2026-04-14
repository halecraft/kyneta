/**
 * Kyneta Bun plugin adapter entry point.
 *
 * Wraps the unplugin-generated Bun plugin with a WASM passthrough handler
 * that prevents unplugin's catch-all onLoad handler (which matches all files)
 * from attempting to read .wasm files as text, which triggers a Bun segfault
 * (confirmed through Bun v1.3.11).
 *
 * The fix registers a .wasm onLoad handler before unplugin's setup runs,
 * so Bun's first-match semantics route WASM files to our handler (which
 * returns them with loader "file") and never reaches unplugin's catch-all.
 *
 * @packageDocumentation
 */

import { createBunPlugin } from "unplugin"
import { type KynetaPluginOptions, unpluginFactory } from "../index.js"

// Minimal Bun types — avoids a dependency on bun-types in the
// framework-agnostic @kyneta/cast package. This adapter only runs
// inside Bun, where these globals are always defined.
declare const Bun: {
  file(path: string): { arrayBuffer(): Promise<ArrayBuffer> }
}

interface BunPluginBuilder {
  onLoad(
    options: { filter: RegExp },
    callback: (args: {
      path: string
    }) => Promise<{ contents: Uint8Array; loader: string }>,
  ): void
}

const inner = createBunPlugin(unpluginFactory)

/**
 * Create a Kyneta Bun build plugin with WASM passthrough baked in.
 */
export default function kyneta(options?: KynetaPluginOptions) {
  const plugin = inner(options)
  const originalSetup = plugin.setup

  plugin.setup = (build: BunPluginBuilder) => {
    // Register WASM passthrough before unplugin's catch-all onLoad.
    // This is always correct — the Cast compiler should never process
    // binary files — and avoids a Bun segfault when WASM-dependent
    // packages (e.g. loro-crdt) are in the dependency graph.
    build.onLoad({ filter: /\.wasm$/ }, async (args: { path: string }) => {
      return {
        contents: new Uint8Array(await Bun.file(args.path).arrayBuffer()),
        loader: "file" as const,
      }
    })

    originalSetup(build)
  }

  return plugin
}

export type { KynetaPluginOptions }
