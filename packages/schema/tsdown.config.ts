import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts", "src/basic/index.ts"],
  dts: true,
  sourcemap: true,
  fixedExtension: false,
})