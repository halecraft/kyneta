import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/client.ts", "src/server.ts", "src/express.ts"],
  dts: true,
  sourcemap: true,
  fixedExtension: false,
})
