// Documentation import check — the imperative half.
//
// Reads the shipped READMEs, hands them to the pure functions in `fences.ts`,
// and reports. This is the wide layer of a two-layer guard; the deep layer is
// `typescript-docs-verifier`, wired into this package's verify config, which
// compiles the blocks that can stand alone straight out of the markdown.
//
// Neither layer subsumes the other. The compiler catches a symbol used without
// being imported, which no import check can see. This catches names and paths
// in the ~108 fragments the compiler cannot take at all.

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { checkImports, extractFences, formatMismatch } from "./fences.js"
import { mapLocation, prepareBlocks } from "./prelude.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, "../../../..")

const require = createRequire(import.meta.url)

/** Every README that ships to a consumer: the root one and each package's. */
function shippedReadmes(): string[] {
  const out = [join(REPO, "README.md")]
  const listed = execFileSync(
    "find",
    [
      join(REPO, "packages"),
      "-name",
      "README.md",
      "-not",
      "-path",
      "*/node_modules/*",
    ],
    { encoding: "utf8" },
  )
  for (const line of listed.trim().split("\n")) if (line) out.push(line)
  return out
}

/**
 * Map a `@kyneta/*` specifier to the value names its built entry exports.
 *
 * pnpm links workspace packages into each package's own `node_modules`, not the
 * repo root, so resolving by name from here does not work. Read the workspace
 * layout instead, honouring each package's `exports` map so that a subpath like
 * `@kyneta/schema/basic` is checked against the basic entry rather than the
 * root one — they export different things.
 */
function buildResolver(): (spec: string) => ReadonlySet<string> | null {
  const entries = new Map<string, string>()

  const listed = execFileSync(
    "find",
    [
      join(REPO, "packages"),
      "-name",
      "package.json",
      "-not",
      "-path",
      "*/node_modules/*",
    ],
    { encoding: "utf8" },
  )
  for (const manifestPath of listed.trim().split("\n")) {
    if (!manifestPath) continue
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: string
      exports?: Record<string, string | Record<string, string>>
    }
    if (!manifest.name) continue
    const dir = dirname(manifestPath)
    const map = manifest.exports ?? { ".": "./dist/index.js" }
    for (const [sub, cond] of Object.entries(map)) {
      const rel =
        typeof cond === "string" ? cond : (cond.import ?? cond.default)
      if (!rel) continue
      const file = resolve(dir, rel)
      if (!existsSync(file)) continue
      entries.set(
        sub === "." ? manifest.name : `${manifest.name}/${sub.slice(2)}`,
        file,
      )
    }
  }

  const cache = new Map<string, ReadonlySet<string> | null>()
  return (spec: string) => {
    if (cache.has(spec)) return cache.get(spec) ?? null
    const entry = entries.get(spec)
    let names: ReadonlySet<string> | null = null
    if (entry) {
      try {
        names = new Set(Object.keys(require(entry) as object))
      } catch {
        names = null
      }
    }
    cache.set(spec, names)
    return names
  }
}

// ---------------------------------------------------------------------------
// The pure core, tested directly over strings
// ---------------------------------------------------------------------------

describe("extractFences", () => {
  it("captures a fence with a clickable 1-indexed line", () => {
    const [fence] = extractFences(
      ["", "```ts", "const a = 1", "```"].join("\n"),
      "x.md",
    )
    expect(fence.code).toBe("const a = 1")
    expect(fence.line).toBe(2)
  })

  it("ignores fences in other languages", () => {
    expect(
      extractFences(["```bash", "ls", "```"].join("\n"), "x.md"),
    ).toHaveLength(0)
  })
})

describe("checkImports", () => {
  const fenceFor = (code: string) =>
    extractFences(`\`\`\`ts\n${code}\n\`\`\``, "x.md")

  it("reports a name the module does not export", () => {
    const [m] = checkImports(
      fenceFor(`import { nope } from "@kyneta/schema"`),
      () => new Set(["batch"]),
    )
    expect(m).toMatchObject({ kind: "unknown-export", name: "nope" })
  })

  it("reports an unresolvable specifier rather than skipping it", () => {
    // The regression that motivated this branch: an earlier check skipped
    // unresolved specifiers, so a README importing from a subpath the package
    // does not publish was reported as clean.
    const [m] = checkImports(
      fenceFor(`import { x } from "@kyneta/nope/sub"`),
      () => null,
    )
    expect(m).toMatchObject({
      kind: "unresolved-module",
      spec: "@kyneta/nope/sub",
    })
  })

  it("skips type-only imports, which a runtime resolver cannot see", () => {
    expect(
      checkImports(
        fenceFor(`import type { Ref } from "@kyneta/schema"`),
        () => new Set(["batch"]),
      ),
    ).toEqual([])
  })

  it("ignores non-kyneta modules", () => {
    expect(
      checkImports(fenceFor(`import { useState } from "react"`), () => null),
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The real documents
// ---------------------------------------------------------------------------

describe("shipped documentation", () => {
  const readmes = shippedReadmes()
  const fences = readmes.flatMap(path =>
    extractFences(readFileSync(path, "utf8"), relative(REPO, path)),
  )

  it("finds the documents it is supposed to be checking", () => {
    // Without this, a broken glob would make the assertion below pass by
    // checking nothing. That is not hypothetical: the first version of this
    // check resolved packages from the repo root, where pnpm does not link
    // them, and so reported a known-broken README as completely clean.
    expect(readmes.length).toBeGreaterThan(10)
    expect(fences.length).toBeGreaterThan(50)
  })

  it("imports only names the packages actually export", () => {
    const mismatches = checkImports(fences, buildResolver())
    expect(mismatches.map(formatMismatch).join("\n")).toBe("")
  })
})

// ---------------------------------------------------------------------------
// Hidden preludes
// ---------------------------------------------------------------------------

describe("prepareBlocks", () => {
  const doc = (body: string) => body.split("|").join("\n")

  it("prepends the nearest prelude to a fence", () => {
    const [block] = prepareBlocks(
      doc("<!-- ts-docs-prelude|declare const x: number|-->||```ts|x + 1|```"),
      "x.md",
    )
    expect(block.source).toBe("declare const x: number\nx + 1")
    expect(block.preludeLines).toBe(1)
  })

  it("replaces rather than accumulates, so two preludes cannot collide", () => {
    const [, second] = prepareBlocks(
      doc(
        "<!-- ts-docs-prelude|const a = 1|-->||```ts|a|```||" +
          "<!-- ts-docs-prelude|const b = 2|-->||```ts|b|```",
      ),
      "x.md",
    )
    expect(second.source).toBe("const b = 2\nb")
  })

  it("adds a setup block to the prelude for its own fence only", () => {
    // The case the exchange README needs: one file-level prelude, plus a line
    // for the single block that expects an `exchange` to already exist.
    const blocks = prepareBlocks(
      doc(
        "<!-- ts-docs-prelude|const a = 1|-->||```ts|a|```||" +
          "<!-- ts-docs-setup|const b = 2|-->||```ts|a + b|```||```ts|a|```",
      ),
      "x.md",
    )
    expect(blocks[0].source).toBe("const a = 1\na")
    expect(blocks[1].source).toBe("const a = 1\nconst b = 2\na + b")
    expect(blocks[2].source).toBe("const a = 1\na")
  })

  it("drops fences marked ignore", () => {
    expect(
      prepareBlocks(
        doc("<!-- ts-docs-verifier:ignore -->||```ts|nope|```"),
        "x.md",
      ),
    ).toHaveLength(0)
  })
})

describe("mapLocation", () => {
  const [block] = prepareBlocks(
    "<!-- ts-docs-prelude\ndeclare const x: number\n-->\n\n```ts\nx\nx + 1\n```",
    "x.md",
  )

  it("maps a compiler line back to the line a reader edits", () => {
    // Prelude is 1 line, so the compiler's line 2 is the fence's first line.
    expect(mapLocation(block, 2)).toMatchObject({ line: block.codeLine })
    expect(mapLocation(block, 3)).toMatchObject({ line: block.codeLine + 1 })
  })

  it("flags a diagnostic that landed inside the prelude", () => {
    expect(mapLocation(block, 1).inPrelude).toBe(true)
    expect(mapLocation(block, 2).inPrelude).toBe(false)
  })
})
