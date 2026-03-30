// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Client Build
//
//   Shared build function and standalone CLI entry point.
//
//   1. Cleans dist/
//   2. Runs Bun.build() — React JSX handled natively via tsconfig
//   3. Attempts brotli pre-compression of each output file
//      (graceful — warns if `brotli` CLI is not installed)
//
//   Run standalone:  bun src/build.ts
//   Or import:       import { buildClient } from "./build.js"
//
// ═══════════════════════════════════════════════════════════════════════════

/// <reference types="bun-types" />

import { rm, exists } from "node:fs/promises"

const DIST = "./dist"

// ─────────────────────────────────────────────────────────────────────────
//  buildClient — build + optional brotli pre-compression
// ─────────────────────────────────────────────────────────────────────────

export async function buildClient() {
  // Clean dist/
  if (await exists(DIST)) {
    await rm(DIST, { recursive: true })
  }

  // Build — Bun handles React JSX natively via tsconfig.json
  const result = await Bun.build({
    entrypoints: ["./public/index.html"],
    outdir: DIST,
  })

  if (!result.success) {
    throw new AggregateError(result.logs, "Client build failed")
  }

  for (const output of result.outputs) {
    console.log(`   ${output.path} (${(output.size / 1024).toFixed(1)} KB)`)
  }

  // Brotli pre-compression
  await compressBrotli(result.outputs.map(o => o.path))

  return result
}

// ─────────────────────────────────────────────────────────────────────────
//  compressBrotli — compress each file to a .br sibling
// ─────────────────────────────────────────────────────────────────────────

async function compressBrotli(paths: string[]) {
  // Probe for the brotli CLI once
  const probe = Bun.spawn(["brotli", "--version"], {
    stdout: "ignore",
    stderr: "ignore",
  })
  const probeCode = await probe.exited
  if (probeCode !== 0) {
    console.warn("   ⚠ brotli not found — skipping pre-compression")
    return
  }

  const results = await Promise.all(
    paths.map(async path => {
      const proc = Bun.spawn(["brotli", "--best", "--keep", path], {
        stdout: "ignore",
        stderr: "pipe",
      })
      const code = await proc.exited
      if (code !== 0) {
        const stderr = await new Response(proc.stderr).text()
        console.warn(`   ⚠ brotli failed for ${path}: ${stderr.trim()}`)
        return null
      }
      const brFile = Bun.file(`${path}.br`)
      const original = Bun.file(path)
      const ratio = ((1 - brFile.size / original.size) * 100).toFixed(0)
      return { path, brSize: brFile.size, ratio }
    }),
  )

  const compressed = results.filter(r => r !== null)
  if (compressed.length > 0) {
    for (const { path, brSize, ratio } of compressed) {
      console.log(
        `   ${path}.br (${(brSize / 1024).toFixed(1)} KB, -${ratio}%)`,
      )
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  CLI entry point
// ─────────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  console.log("✅ Client build succeeded:")
  await buildClient()
}