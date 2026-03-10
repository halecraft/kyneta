import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "compiler/index": "src/compiler/index.ts",
    "vite/plugin": "src/vite/plugin.ts",
    "server/index": "src/server/index.ts",
    "loro/index": "src/loro/index.ts",
    "runtime/index": "src/runtime/index.ts",
    "testing/index": "src/testing/index.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["@loro-extended/change", "loro-crdt"],
})
