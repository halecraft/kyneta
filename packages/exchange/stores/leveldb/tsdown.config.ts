import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts"],
  dts: true,
  sourcemap: true,
  fixedExtension: false,
  deps: { neverBundle: ["classic-level"] },
})
