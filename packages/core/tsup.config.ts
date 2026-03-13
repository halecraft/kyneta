import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "compiler/index": "src/compiler/index.ts",
    "unplugin/index": "src/unplugin/index.ts",
    "unplugin/adapters/vite": "src/unplugin/adapters/vite.ts",
    "unplugin/adapters/bun": "src/unplugin/adapters/bun.ts",
    "unplugin/adapters/farm": "src/unplugin/adapters/farm.ts",
    "unplugin/adapters/rollup": "src/unplugin/adapters/rollup.ts",
    "unplugin/adapters/rolldown": "src/unplugin/adapters/rolldown.ts",
    "unplugin/adapters/esbuild": "src/unplugin/adapters/esbuild.ts",
    "vite/plugin": "src/vite/plugin.ts",
    "server/index": "src/server/index.ts",
    "runtime/index": "src/runtime/index.ts",
    "testing/index": "src/testing/index.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
})