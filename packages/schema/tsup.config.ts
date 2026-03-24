import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/basic/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
})
