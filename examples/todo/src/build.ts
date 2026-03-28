// ═══════════════════════════════════════════════════════════════════════════
//
//   Todo — Client Build Script
//
//   Standalone build step that compiles the client app using Bun.build()
//   with the Cast unplugin. Produces dist/ with the bundled JS + WASM.
//
//   Used by:
//   - `bun run build` — pre-build before running the Node.js variant
//   - `src/server.ts` inlines this same Bun.build() call directly
//
//   Run with:  bun src/build.ts
//
// ═══════════════════════════════════════════════════════════════════════════

/// <reference types="bun-types" />

import kyneta from "@kyneta/cast/unplugin/bun"

const result = await Bun.build({
  entrypoints: ["./public/index.html"],
  outdir: "./dist",
  plugins: [kyneta()],
})

if (!result.success) {
  console.error("Build failed:")
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

console.log("✅ Client build succeeded:")
for (const output of result.outputs) {
  console.log(`   ${output.path} (${(output.size / 1024).toFixed(1)} KB)`)
}