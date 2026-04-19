// ═══════════════════════════════════════════════════════════════════════════
//
//   Brotli Pre-Compression — FC/IS
//
//   Functional core:  planCompression()  — pure decision, trivially testable
//   Imperative shell: compressBrotli()   — reads, compresses, writes, logs
//
//   Uses node:zlib (built into Bun and Node) instead of shelling out to
//   the system `brotli` CLI. Produces identical output at BROTLI_MAX_QUALITY.
//
// ═══════════════════════════════════════════════════════════════════════════

/// <reference types="bun-types" />

import { promisify } from "node:util"
import { brotliCompress as brotliCompressCb, constants } from "node:zlib"

const brotliCompress = promisify(brotliCompressCb)

// ─────────────────────────────────────────────────────────────────────────
//  Functional Core — pure compression plan
// ─────────────────────────────────────────────────────────────────────────

export type CompressionPlan =
  | { action: "skip"; reason: string }
  | { action: "compress"; files: string[] }

export function planCompression(
  paths: string[],
  env: Record<string, string | undefined> = process.env,
): CompressionPlan {
  if (env.SKIP_BROTLI) return { action: "skip", reason: "SKIP_BROTLI is set" }
  if (paths.length === 0) return { action: "skip", reason: "no files" }
  return { action: "compress", files: paths }
}

// ─────────────────────────────────────────────────────────────────────────
//  Imperative Shell — execute the compression plan
// ─────────────────────────────────────────────────────────────────────────

export async function compressBrotli(paths: string[]): Promise<void> {
  const plan = planCompression(paths)

  if (plan.action === "skip") {
    console.log(`   ⏭ brotli skipped — ${plan.reason}`)
    return
  }

  const results = await Promise.all(plan.files.map(compressFile))

  for (const result of results) {
    if (result) {
      console.log(
        `   ${result.path}.br (${(result.brSize / 1024).toFixed(1)} KB, -${result.ratio}%)`,
      )
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  compressFile — compress a single file to a .br sibling
// ─────────────────────────────────────────────────────────────────────────

interface CompressionResult {
  path: string
  brSize: number
  ratio: string
}

async function compressFile(
  path: string,
): Promise<CompressionResult | null> {
  try {
    const original = Bun.file(path)
    const input = Buffer.from(await original.arrayBuffer())

    const compressed = await brotliCompress(input, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      },
    })

    await Bun.write(`${path}.br`, compressed)

    const ratio = ((1 - compressed.length / input.length) * 100).toFixed(0)
    return { path, brSize: compressed.length, ratio }
  } catch (err) {
    console.warn(
      `   ⚠ brotli failed for ${path}: ${err instanceof Error ? err.message : err}`,
    )
    return null
  }
}