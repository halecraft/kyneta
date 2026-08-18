#!/usr/bin/env bun
// Hidden preludes — the imperative half.
//
// Reads the documents listed below, pairs each code block with the prelude in
// effect where it appears (see `prelude.ts` for why that exists), hands the
// synthesized blocks to `typescript-docs-verifier`, and rewrites the reported
// locations so they point at the README a reader actually edits.
//
// Run by the `docs` task in verify.config.ts.

import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  mapLocation,
  type PreparedBlock,
  prepareBlocks,
  renderForCompiler,
} from "./prelude.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, "../..")
const REPO = resolve(PKG, "../..")

/**
 * The documents whose examples must compile.
 *
 * Explicit rather than a glob: adding a README here is a deliberate act, and
 * the list doubles as the record of what is and is not covered. Every file
 * listed needs its narrative setup written as a `ts-docs-prelude`, so growing
 * this list is work rather than configuration.
 */
const DOCUMENTS = [
  "README.md",
  "packages/exchange/README.md",
  "packages/react/README.md",
  "packages/index/README.md",
]

function main(): void {
  const blocks: PreparedBlock[] = []
  for (const relPath of DOCUMENTS) {
    const markdown = readFileSync(join(REPO, relPath), "utf8")
    blocks.push(...prepareBlocks(markdown, relPath))
  }

  if (blocks.length === 0) {
    console.error("doc-check: no blocks found — the document list is wrong")
    process.exit(1)
  }

  const dir = mkdtempSync(join(tmpdir(), "kyneta-docs-"))
  const synthetic = join(dir, "snippets.md")
  writeFileSync(synthetic, renderForCompiler(blocks))

  // Resolve the CLI through node rather than trusting PATH: pnpm links this
  // bin into the workspace root's .bin, not this package's, so a bare name
  // silently fails to spawn and the run looks like it passed with no output.
  const require = createRequire(import.meta.url)
  const manifest = require.resolve("typescript-docs-verifier/package.json")
  const bin = resolve(
    dirname(manifest),
    (require(manifest) as { bin: Record<string, string> }).bin[
      "typescript-docs-verifier"
    ],
  )

  let output: string
  let failed = false
  try {
    output = execFileSync(
      process.execPath,
      [bin, "--input-files", synthetic, "--project", "tsconfig.json"],
      { cwd: PKG, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    output = `${e.stdout ?? ""}${e.stderr ?? ""}`
    failed = true
  }

  console.log(rewriteLocations(output, blocks, synthetic))
  console.log(
    failed
      ? `✖ ${DOCUMENTS.length} documents checked — see above`
      : `✔ ${blocks.length} documented examples compiled across ${DOCUMENTS.length} documents`,
  )
  process.exit(failed ? 1 : 0)
}

/**
 * Rewrite `<temp> → Code Block N(line,col)` as `<readme>:<line>:<col>`.
 *
 * Block order in the synthetic document matches `blocks`, which is what makes
 * the index meaningful. Without this the errors point into a temporary file
 * that no longer exists by the time anyone reads them.
 */
function rewriteLocations(
  output: string,
  blocks: PreparedBlock[],
  syntheticPath: string,
): string {
  const LOCATION = /^(\s*).*Code Block (\d+)\((\d+),(\d+)\):(.*)$/gm

  return output
    .replace(LOCATION, (whole, indent, index, line, col, rest) => {
      const block = blocks[Number(index) - 1]
      if (!block) return whole
      const at = mapLocation(block, Number(line))
      // A diagnostic inside the prelude itself is a mistake in the prelude, not
      // in the prose; point at the fence and say so rather than at a line the
      // reader cannot see.
      if (at.inPrelude) {
        return `${indent}${at.file}:${at.line} (in this block's ts-docs-prelude):${rest}`
      }
      return `${indent}${at.file}:${at.line}:${col}:${rest}`
    })
    .split(syntheticPath)
    .join("documented examples")
}

main()
