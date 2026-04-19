/// <reference types="bun-types" />

import { rm } from "node:fs/promises"
import { compressBrotli } from "./compress.js"

// ─────────────────────────────────────────────────────────────────────────
//  buildClient — clean, bundle, compress
// ─────────────────────────────────────────────────────────────────────────

export interface BuildClientOptions {
  entrypoints?: string[]
  outdir?: string
  plugins?: import("bun").BunPlugin[]
}

export async function buildClient(opts?: BuildClientOptions) {
  const entrypoints = opts?.entrypoints ?? ["./public/index.html"]
  const outdir = opts?.outdir ?? "./dist"
  const plugins = opts?.plugins ?? []

  await rm(outdir, { recursive: true, force: true })

  const result = await Bun.build({ entrypoints, outdir, plugins })

  if (!result.success) {
    throw new AggregateError(result.logs, "Client build failed")
  }

  for (const output of result.outputs) {
    console.log(`   ${output.path} (${(output.size / 1024).toFixed(1)} KB)`)
  }

  await compressBrotli(result.outputs.map(o => o.path))

  return result
}