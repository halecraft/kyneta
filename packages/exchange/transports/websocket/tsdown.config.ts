import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/browser.ts", "src/server.ts", "src/bun.ts"],
  dts: true,
  sourcemap: true,
  fixedExtension: false,
})
