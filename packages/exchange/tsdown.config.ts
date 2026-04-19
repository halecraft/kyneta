import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts", "src/testing/index.ts"],
  dts: true,
  sourcemap: true,
  fixedExtension: false,
  deps: { neverBundle: ["vitest"] },
})
