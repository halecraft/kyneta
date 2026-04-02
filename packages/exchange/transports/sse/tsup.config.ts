import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/client.ts", "src/server.ts", "src/express.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
})
